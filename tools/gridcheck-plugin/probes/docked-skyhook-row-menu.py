# Read the docked Skyhook row menu in its current-system and remote-system forms.
from utillib import KeyVal
from eveservices.menu import GetMenuService
from eve.client.script.ui.structure.structureBrowser.entries.skyhookEntry import SkyhookEntry
import evetypes

menu_service = GetMenuService()
type_id = 81080
item_id = 9988400004071
remote = 30000208

def labels(entries):
    result = []
    for entry in entries:
        if entry is None:
            result.append(None)
        else:
            if isinstance(entry, (tuple, list)):
                label = entry[0]
                if isinstance(label, tuple):
                    label = label[0]
            else:
                label = entry.GetTextDescriptive()
            result.append(unicode(label))
    return result

def row_menu(system_id):
    controller = KeyVal(GetItemID=lambda: item_id, GetTypeID=lambda: type_id,
                        GetSolarSystemID=lambda: system_id,
                        GetCategoryID=lambda: evetypes.GetCategoryID(type_id))
    return SkyhookEntry.GetMenu.im_func(KeyVal(controller=controller))

result = {'current': labels(row_menu(session.solarsystemid2)), 'remote': labels(row_menu(remote)),
          'system': labels(menu_service.CelestialMenu(remote)), 'systemID': remote}
