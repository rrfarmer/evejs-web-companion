# The Overview Settings Appearance lists as the 3698585 client has them by default (AppearancePanel.LoadFlags): the
# whole Colortag ('flag') and Background orders (stateSvc.GetStateOrder), each state on or off (GetStateState), its
# colour and blink, and the groups the "other objects" setting adds (stateSvc.filterGroups). The defaults are read, whatever
# the client's pilot has saved:
#   node tools/gridcheck/bin/gridcheck.js client eval --json --file tools/client-extract/overviewStateOrders.py
# The page reads it as _local/client-assets/<build>/overviewStateOrders.json: {source, ...the result}.
svc = sm.GetService('stateSvc')
# The defaults themselves (defaultFlagOrder / defaultBackgroundOrder, defaultFlagStates / defaultBackgroundStates,
# _GetDefaultColor, defaultBlinkStates), not GetStateOrder / GetStateState / GetStateColor / GetStateBlink: those give a
# pilot's saved settings, and the client read here (2026-11-24) had a pilot's own from an older build
def order(where):
    default = list(svc.defaultBackgroundOrder if where == 'background' else svc.defaultFlagOrder)
    states = set(svc.defaultBackgroundStates if where == 'background' else svc.defaultFlagStates)
    out = []
    for flag in default:
        out.append({
            'flag': flag,
            'on': flag in states,
            'color': [round(x, 3) for x in svc._GetDefaultColor(flag, where)],
            'blink': bool(svc.defaultBlinkStates.get((where, flag), False)),
        })
    return out
result = {'flag': order('flag'), 'background': order('background'), 'filterGroups': sorted(svc.filterGroups)}
