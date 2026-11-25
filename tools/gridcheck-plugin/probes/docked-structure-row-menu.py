# Read station and Upwell row menus without invoking any entries.
from eve.client.script.ui.structure.structureBrowser.structureBrowserWnd import StructureBrowserWnd
from eveservices.menu import GetMenuService

window = StructureBrowserWnd.GetIfOpen()
already_open = window is not None
if not already_open:
    window = StructureBrowserWnd.Open()
try:
    rows = window.controller.GetAllStructures(const.rangeRegion)
    samples = []
    for row in rows:
        item_id = row.GetItemID()
        if item_id not in (session.stationid, 60003760, 1030000000000):
            continue
        menu = GetMenuService().GetMenuFromItemIDTypeID(itemID=item_id, typeID=row.GetTypeID())
        labels = []
        for entry in menu:
            if entry is None:
                labels.append(None)
                continue
            if isinstance(entry, (tuple, list)):
                label = entry[0]
                if isinstance(label, tuple):
                    label = label[0]
            else:
                label = entry.GetTextDescriptive()
            labels.append(unicode(label))
        samples.append({'id': item_id, 'system': row.GetSolarSystemID(), 'menu': labels})
    result = {'station': session.stationid, 'rows': samples}
finally:
    if not already_open:
        window.Close()
