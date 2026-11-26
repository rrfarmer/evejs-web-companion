from localization import GetByLabel
from pvpFilaments.client.event_window.window import PVPFilamentEventWindow
from pvpFilaments.client.event_window.controller import PVPFilamentEventInfoController

from eve.client.script.ui.shared.neocom.neocom import neocomConst
from neocom2 import btnIDs

service = sm.GetService('pvpFilamentSvc')
active = [entry for entry in service.GetActiveEvents() if not entry['QA']]
event = sorted(active, key=lambda entry: entry['startDate'])[0] if active else service.GetMostRecentEvent()
error = None
try:
    PVPFilamentEventInfoController(None)
except UnboundLocalError as exc:
    error = str(exc)
result = {
    'station': session.stationid,
    'caption': GetByLabel(PVPFilamentEventWindow.default_captionLabelPath),
    'size': [PVPFilamentEventWindow.default_fixedWidth, PVPFilamentEventWindow.default_fixedHeight],
    'inactiveCaption': GetByLabel('UI/PVPFilament/EventWindow/InactiveWindow'),
    'finalCaption': GetByLabel('UI/PVPFilament/EventWindow/FinalResults'),
    'active': len(active),
    'launcher': btnIDs.PVP_FILAMENTS_ID in [entry[1] for entry in neocomConst.RAWDATA_EVEMENU_GROUP_ACTIVITIES[2]],
    'controllerError': error,
    'event': [event['matchTypeID'], event['scheduleID'], event['filamentTypeID']] if event else None,
    'nextDate': str(service.GetNextEventDate())
}
