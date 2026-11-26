import blue
import re
from localization import GetByLabel
from eve.client.script.ui.shared.dockedUI.controllers.stationController import StationController
from eve.client.script.ui.shared.dockedUI.controllers.structureController import StructureController

def wait_for(predicate):
    for _ in xrange(48):
        if predicate():
            return True
        blue.synchro.SleepWallclock(250)
    return False

def measure():
    station = session.stationid
    ship = session.shipid
    slash = sm.RemoteSvc('slash')
    native = sm.GetService('structureControl')
    result = {
        'npcControllable': StationController(station).IsControlable(),
        'take': GetByLabel('UI/Commands/TakeStructureControl'),
        'release': GetByLabel('UI/Inflight/HUDOptions/ReleaseControl'),
        'hint': GetByLabel('UI/Station/TakeControlHint'),
        'deniedHint': GetByLabel('UI/Station/MayNotTakeControlHint')
    }
    sid = None
    try:
        seeded = str(slash.SlashCmd('/upwell seed fortizar CodexLobbyControl'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if not match:
            return dict(result, fixtureError=seeded)
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid):
            return dict(result, fixtureError='No Fortizar session')
        control = StructureController(sid)
        result.update(controllable=control.IsControlable(), allowed=control.MayTakeControl(sid),
                      pilotBefore=control.GetStructurePilot(sid))
        if result['allowed']:
            control.TakeControl()
            result['took'] = wait_for(lambda: session.shipid == sid)
            result['pilotAfter'] = control.GetStructurePilot(sid)
            native.ReleaseControl()
            result['released'] = wait_for(lambda: session.shipid == ship and session.structureid == sid)
            result['pilotReleased'] = control.GetStructurePilot(sid)
        return result
    except Exception as exc:
        return dict(result, fixtureError=str(exc))
    finally:
        if sid:
            if session.shipid == sid:
                native.ReleaseControl()
                wait_for(lambda: session.shipid != sid)
            slash.SlashCmd('/tr me %d' % station)
            wait_for(lambda: session.stationid == station)
            slash.SlashCmd('/upwell remove %d' % sid)

result = measure()
