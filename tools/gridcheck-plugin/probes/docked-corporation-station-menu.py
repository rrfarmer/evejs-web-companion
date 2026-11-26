from utillib import KeyVal


def label_of(entry):
    if isinstance(entry, (list, tuple)) and entry:
        entry = entry[0]
    if hasattr(entry, 'GetLabelPath'):
        return entry.GetLabelPath()
    return getattr(entry, 'labelPath', entry if isinstance(entry, basestring) else None)


def observe():
    info = sm.GetService('info')
    cases = {}
    for station in (60015169, 60003760, session.stationid):
        menu = info.GetMenuLocationMenu(KeyVal(itemID=station))
        cases[station] = [label for label in map(label_of, menu) if label]
    return dict(station=session.stationid, menus=cases)


result = observe()
