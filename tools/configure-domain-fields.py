"""Add optional domain fields to existing Close billing paths; never changes webhook filters.

Run with a temporary key through getpass. Writes only nonsecret route configuration.
Deploy the resulting configuration after sandbox verification.
"""
import argparse, base64, getpass, json, pathlib, re, urllib.request
ROOT = pathlib.Path(__file__).resolve().parents[1]

def run(key, mode):
    def api(path, body=None):
        if not re.fullmatch(r'(?:custom_activity/actitype_[A-Za-z0-9]+/|custom_field/activity/)', path):
            raise ValueError('Endpoint outside field configuration scope')
        req = urllib.request.Request('https://api.close.com/api/v1/' + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Authorization':'Basic '+base64.b64encode((key+':').encode()).decode(), 'Content-Type':'application/json'})
        with urllib.request.urlopen(req, timeout=30) as response: return json.load(response)
    configs = [json.loads(m) for m in re.findall(r"CLOSE_BILLING_CONFIG = '(.*?)'", (ROOT/'wrangler.toml').read_text())]
    config = next(c for c in configs if c['mode'] == mode)
    for route in config['paths']:
        typ = api('custom_activity/'+route['proposalType']+'/')
        assert typ['organization_id'] == config['organizationId']
        fields = route['proposalFields']
        template = next(f for f in typ['fields'] if f['id'] == fields['project'])
        output_template = next(f for f in typ['fields'] if f['id'] == fields['link'])
        specs = [
            ('domainName','Domain name (optional)','text','Example: example.com. Leave both domain fields blank if we are not supplying a domain.'),
            ('domainAmount','Domain price (USD/year)','number','Full amount charged upfront for the first year, then the same amount automatically every year starting one year after payment. This is separate from the website build and monthly hosting.'),
            ('domainSubscription','Domain renewal subscription','text','Filled automatically after successful initial domain payment. Annual domain billing is independent of monthly hosting.')]
        for name,label,kind,description in specs:
            matches=[f for f in typ['fields'] if f['name']==label]
            if len(matches)>1: raise ValueError('Duplicate field requires review')
            if matches: result=matches[0]
            else:
                source=output_template if name=='domainSubscription' else template
                body={'custom_activity_type_id':typ['id'],'name':label,'type':kind,'required':False,'accepts_multiple_values':False,'description':description}
                if 'editable_with_roles' in source: body['editable_with_roles']=source['editable_with_roles']
                result=api('custom_field/activity/',body)
            assert result['type']==kind
            fields[name]=result['id']
    destination=ROOT.parent/('domain-billing-config-'+mode+'.json')
    destination.write_text(json.dumps(config,indent=2)+'\n')
    print('Nonsecret configuration saved to '+str(destination))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('mode',choices=['test','live']);args=parser.parse_args()
    run(getpass.getpass('Temporary Close key: '),args.mode)
