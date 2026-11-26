import blue
import re
from carbonui.uicore import uicore
from localization import GetByLabel
from eve.client.script.ui.shared.dockedUI.controllers.structureController import StructureController
from eve.client.script.ui.shared.dockedUI.controllers.stationController import StationController

def wait_for(predicate):
    for _ in xrange(40):
        if predicate():
            return True
        blue.synchro.SleepWallclock(250)
    return False

def measure():
    station = session.stationid
    service = sm.GetService('viewState')
    data = {
        'npcStation': station,
        'npcHasDockModes': StationController(station).HasDockModes(),
        'enterOutside': GetByLabel('UI/Commands/EnterStructure'),
        'enterHangar': GetByLabel('UI/Commands/EnterHangar')
    }
    slash = sm.RemoteSvc('slash')
    sid = None
    try:
        seeded = str(slash.SlashCmd('/upwell seed astrahus CodexView13561'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if match is None:
            data['fixtureError'] = seeded
            return data
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid and service.IsPrimaryViewActive('hangar')):
            data['fixtureError'] = 'No docked hangar'
            return data
        control = StructureController(sid)
        data['structureHasDockModes'] = control.HasDockModes()
        data['hangarAction'] = control.GetDockedModeTextPath()
        control.ChangeDockedMode(service)
        data['outside'] = wait_for(lambda: service.IsPrimaryViewActive('structure'))
        data['outsideAction'] = control.GetDockedModeTextPath()
        def has_structure_ball():
            park = sm.GetService('michelle').GetBallpark()
            return bool(park and park.GetBall(sid))
        data['outsideBall'] = wait_for(has_structure_ball)
        wait_for(lambda: not service.HasActiveTransition())
        control.ChangeDockedMode(service)
        data['hangar'] = wait_for(lambda: service.IsPrimaryViewActive('hangar'))
        return data
    except Exception as exc:
        data['fixtureError'] = str(exc)
        return data
    finally:
        if sid:
            slash.SlashCmd('/tr me %d' % station)
            wait_for(lambda: session.stationid == station)
            slash.SlashCmd('/upwell remove %d' % sid)

result = measure()
