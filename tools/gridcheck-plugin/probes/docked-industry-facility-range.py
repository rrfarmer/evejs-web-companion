from eve.client.script.ui.shared.industry.browserFacilities import BrowserFacilities, OWNER_ANY
from utillib import KeyVal


def observe():
    panel = BrowserFacilities.__new__(BrowserFacilities)
    panel.filterEdit = KeyVal(GetValue=lambda: '')
    panel.activityCombo = KeyVal(GetValue=lambda: 0)
    panel.ownerCombo = KeyVal(GetValue=lambda: OWNER_ANY)
    options = panel.GetRangeOptions()
    samples = []
    for system_id in (session.solarsystemid2, 30000142, 30000121, 30002187, 31000001):
        row = KeyVal(activities=[1], ownerID=0, solarSystemID=system_id)
        included = []
        for _, value in options:
            panel.rangeCombo = KeyVal(GetValue=lambda: value)
            if not panel.IsFilteredOut(row):
                included.append(value)
        samples.append({'system': system_id, 'jumps': panel.GetJumpsTo(system_id), 'included': included})
    return {'station': session.stationid, 'system': session.solarsystemid2,
            'options': options, 'samples': samples}


result = observe()
