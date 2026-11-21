# The Overview Settings Exceptions list as the 3698585 client builds it (StatesPanel.Load): every state of
# stateSvc.GetStateProps() but flagForcedOn, its text, hint, iconIndex and colours, read from a running client:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/overviewStates.py
# The page reads it as _local/client-assets/<build>/overviewStates.json: {source, states: <the result>}.
from eve.client.script.parklife import states as stateConst
svc = sm.GetService('stateSvc')
out = []
for flag, props in svc.GetStateProps().iteritems():
    if flag == stateConst.flagForcedOn:
        continue
    out.append({
        'flag': flag,
        'label': props.label,
        'text': props.text,
        'hint': getattr(props, 'hint', None),
        'iconIndex': props.iconIndex,
        'iconColor': [round(x, 3) for x in props.iconColor],
        'flagColor': [round(x, 3) for x in svc.GetStateFlagColor(flag)],
    })
result = out
