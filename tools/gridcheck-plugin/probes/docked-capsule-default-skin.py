"""Read the capsule's native SKIN catalog and docked assembly entry points."""
import evetypes
from eve.client.script.ui.shared.skins.defaultSkinSettings import get_default_skin_id_for_hull
from localization import GetByLabel

capsule_type_id = 670
cosmetics = sm.GetService('cosmeticsSvc')
station = sm.GetService('station')
result = {
    'stationID': session.stationid,
    'activeShipID': session.shipid,
    'capsuleTypeID': capsule_type_id,
    'capsuleName': evetypes.GetName(capsule_type_id),
    'skinIDs': sorted(skin.skinID for skin in cosmetics.static.GetSkinsForTypeID(capsule_type_id) or ()),
    'defaultSkinID': get_default_skin_id_for_hull(capsule_type_id),
    'subscribesToAssembly': 'OnPodOrCorvetteAssembly' in cosmetics.__notifyevents__,
    'tryLeaveShip': callable(getattr(station, 'TryLeaveShip', None)),
    'leaveShipLabel': GetByLabel('UI/Inventory/ItemActions/LeaveShip'),
}
