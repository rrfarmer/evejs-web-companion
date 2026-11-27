"""Read the installed client's corvette SKIN catalogs and assembly hook while docked."""
import evetypes
from eve.client.script.ui.shared.skins.defaultSkinSettings import get_default_skin_id_for_hull
from localization import GetByLabel

service = sm.GetService('cosmeticsSvc')
corvettes = {}
for type_id in (588, 596, 601, 606):
    skins = service.static.GetSkinsForTypeID(type_id) or ()
    corvettes[str(type_id)] = {
        'name': evetypes.GetName(type_id),
        'skinIDs': sorted(skin.skinID for skin in skins),
        'defaultSkinID': get_default_skin_id_for_hull(type_id),
    }

result = {
    'stationID': session.stationid,
    'shipID': session.shipid,
    'lobbyButton': GetByLabel('UI/Station/CreateNewbieShipButton'),
    'subscribesToAssembly': 'OnPodOrCorvetteAssembly' in service.__notifyevents__,
    'corvettes': corvettes,
}
