"""One-off, operator-run Close configuration. Never runs in the billing server.

Prepare creates hidden/API-only actions and outputs non-secret config. Activate,
after deployment verification, exposes the forms and expands existing filters.
An API key is read with getpass, kept in memory, never written or printed.
"""
import argparse, base64, copy, getpass, json, pathlib, re, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
PATHS = json.loads((ROOT / 'tools/billing-paths.json').read_text())
AUTH = 'Website is live and signed billing authorization is on file'


def run(key, mode, phase):
    def api(path, body=None, method=None):
        if not re.fullmatch(r'(?:custom_activity/(?:actitype_[A-Za-z0-9]+/)?|custom_field/activity/(?:cf_[A-Za-z0-9]+/)?|webhook/whsub_[A-Za-z0-9]+/)', path):
            raise ValueError('Endpoint outside setup scope')
        req = urllib.request.Request('https://api.close.com/api/v1/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            method=method or ('POST' if body is not None else 'GET'),
            headers={'Authorization': 'Basic ' + base64.b64encode((key + ':').encode()).decode(), 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)

    configs = [json.loads(m) for m in re.findall(r"CLOSE_BILLING_CONFIG = '(.*?)'", (ROOT/'wrangler.toml').read_text())]
    config = next(c for c in configs if c['mode'] == mode)
    prefix = '(sandbox) ' if mode == 'test' else ''
    output = ROOT.parent / ('close-billing-paths-' + mode + '.json')
    if phase == 'prepare':
        types_response = api('custom_activity/')
        if types_response.get('has_more'):
            raise ValueError('Paginated activity list requires review before setup')
        types = types_response['data']
        originals = {kind: api('custom_activity/' + config[kind + 'Type'] + '/') for kind in ['proposal', 'launch']}
        routes = []
        for spec in PATHS:
            route = {'billingPath': spec['billingPath']}
            for kind in ['proposal', 'launch']:
                name = prefix + ('Proposal — ' if kind == 'proposal' else 'Launch — ') + spec['label']
                matches = [t for t in types if t['name'] == name]
                if len(matches) > 1: raise ValueError('Duplicate action name needs review')
                original = originals[kind]
                assert original['organization_id'] == config['organizationId']
                description = spec[kind + 'Description']
                typ = matches[0] if matches else api('custom_activity/', {'name': name, 'description': description,
                    'api_create_only': True, 'editable_with_roles': original['editable_with_roles']})
                assert typ['organization_id'] == config['organizationId']
                typ = api('custom_activity/' + typ['id'] + '/')
                route[kind + 'Type'] = typ['id']
                fields = {}
                source_fields = {f['id']: f for f in original['fields']}
                names = ['project', 'build', 'hosting', 'status', 'link', 'deposit', 'final', 'subscription'] if kind == 'proposal' else ['invoice', 'authorization', 'result']
                for name_key in names:
                    if kind == 'proposal' and ((spec['billingPath'] == 'hosting_only' and name_key in ['build', 'final']) or
                        (spec['billingPath'] == 'website_only' and name_key in ['hosting', 'subscription']) or
                        (spec['billingPath'] == 'full_hosting' and name_key == 'final')): continue
                    source = source_fields[config[kind + 'Fields'][name_key]]
                    label = 'Launch reference' if name_key in ['deposit', 'invoice'] else source['name']
                    existing = [f for f in typ['fields'] if f['name'] == label]
                    if len(existing) > 1: raise ValueError('Duplicate field name needs review')
                    if existing: field = existing[0]
                    else:
                        body = {k: copy.deepcopy(source[k]) for k in ['type', 'accepts_multiple_values', 'choices', 'editable_with_roles', 'required'] if k in source}
                        body.update(custom_activity_type_id=typ['id'], name=label)
                        body['description'] = ('Filled automatically after successful payment or card setup. Copy into the matching launch action.' if name_key == 'deposit' else
                            ('Paste the launch reference from the matching proposal on this lead.' if name_key == 'invoice' else source.get('description', '')))
                        field = api('custom_field/activity/', body)
                    fields[name_key] = field['id']
                route[kind + 'Fields'] = fields
            routes.append(route)
        config['paths'] = routes
        output.write_text(json.dumps(config, indent=2) + '\n')
        print('Prepared hidden forms; non-secret config: ' + str(output))
    else:
        prepared = json.loads(output.read_text())
        assert prepared['organizationId'] == config['organizationId'] and prepared['subscriptionId'] == config['subscriptionId']
        assert config.get('paths') == prepared['paths'], 'Deploy the prepared configuration first'
        webhook = api('webhook/' + config['subscriptionId'] + '/')
        expected_origin = 'https://stripe-sandbox.nolimitwebs.pages.dev' if mode == 'test' else 'https://nolimitwebs.com'
        assert webhook['url'] == expected_origin + '/api/close-webhook' and webhook['verify_ssl'] is True
        ids = [config['proposalType'], config['launchType']] + [r[k] for r in config['paths'] for k in ['proposalType', 'launchType']]
        events = copy.deepcopy(webhook['events'])
        assert len(events) == 2 and {e['action'] for e in events} == {'created', 'updated'}
        for event in events:
            assert event['object_type'] == 'activity.custom_activity'
            event['extra_filter'] = {'type':'field_accessor','field':'data','filter':{
                'type':'field_accessor','field':'custom_activity_type_id','filter':{
                    'type':'or','filters':[{'type':'equals','value':i} for i in ids]}}}
        api('webhook/' + config['subscriptionId'] + '/', {'events':events}, 'PUT')
        for route in config['paths']:
            for kind in ['proposal', 'launch']:
                api('custom_activity/' + route[kind+'Type'] + '/', {'api_create_only':False}, 'PUT')
        api('custom_activity/' + config['proposalType'] + '/', {'api_create_only':True, 'name':prefix+'Legacy proposal — existing projects'}, 'PUT')
        api('custom_activity/' + config['launchType'] + '/', {'name':prefix+'Legacy launch — existing proposals only',
            'description':'Use only for proposals created with the original Create website proposal action. New proposals use their matching named launch action.'}, 'PUT')
        print('Activated named actions; retained legacy launch and original webhook destination/security.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['prepare','activate'])
    parser.add_argument('mode', choices=['test','live'])
    args = parser.parse_args()
    run(getpass.getpass('Temporary Close API key: '), args.mode, args.phase)
