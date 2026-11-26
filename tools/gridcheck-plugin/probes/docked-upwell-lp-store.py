import blue
import re
from eve.common.script.sys.idCheckers import IsNPC
from eve.client.script.ui.shared.dockedUI.controllers.structureController import StructureController
from localization import GetByLabel

def measure():
    station = session.stationid
    slash = sm.RemoteSvc('slash')
    sid = None
    try:
        seeded = str(slash.SlashCmd('/upwell seed astrahus CodexLpStoreAccess'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if not match:
            return {'fixtureError': seeded}
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        views = sm.GetService('viewState')
        for _ in xrange(48):
            if session.structureid == sid and views.IsPrimaryViewActive('hangar'):
                break
            blue.synchro.SleepWallclock(250)
        if session.structureid != sid:
            return {'fixtureError': 'No Astrahus session'}
        owner = sm.RemoteSvc('structureDirectory').GetStructureInfo(sid).ownerID
        controller = StructureController(sid)
        return dict(owner=owner, npc=IsNPC(owner), label=GetByLabel('UI/Station/LPStore'),
                    access=bool(controller.GetCurrentStateForService(11).isEnabled))
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        if sid:
            slash.SlashCmd('/tr me %d' % station)
            for _ in xrange(48):
                if session.stationid == station:
                    break
                blue.synchro.SleepWallclock(250)
            slash.SlashCmd('/upwell remove %d' % sid)

result = measure()
