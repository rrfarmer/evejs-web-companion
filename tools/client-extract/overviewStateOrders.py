# The Overview Settings Appearance lists as the 3698585 client has them by default (AppearancePanel.LoadFlags): the
# whole Colortag ('flag') and Background orders (stateSvc.GetStateOrder), each state on or off (GetStateState), its
# colour and blink, and the groups the "other objects" setting adds (stateSvc.filterGroups). Read from a client whose
# overview settings are its defaults:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/overviewStateOrders.py
# The page reads it as _local/client-assets/<build>/overviewStateOrders.json: {source, ...the result}.
svc = sm.GetService('stateSvc')
def order(where):
    out = []
    for flag in svc.GetStateOrder(where):
        out.append({
            'flag': flag,
            'on': bool(svc.GetStateState(where, flag)),
            'color': [round(x, 3) for x in svc.GetStateColor(flag, where)],
            'blink': bool(svc.GetStateBlink(where, flag)),
        })
    return out
result = {'flag': order('flag'), 'background': order('background'), 'filterGroups': sorted(svc.filterGroups)}
