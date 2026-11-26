import blue
import re
from localization import GetByLabel
from eve.client.script.ui.shared.dockedUI.controllers.structureController import StructureController

def wait_for(predicate):
    for _ in xrange(48):
        if predicate():
            return True
        blue.synchro.SleepWallclock(250)
    return False

def measure():
    station = session.stationid
    slash = sm.RemoteSvc('slash')
    sid = None
    try:
        seeded = str(slash.SlashCmd('/upwell seed astrahus CodexLobbyServices'))
        match = re.search(r'(?<!\d)\d{10,}(?!\d)', seeded)
        if not match:
            return {'fixtureError': seeded}
        sid = long(match.group(0))
        slash.SlashCmd('/tr me %d' % sid)
        if not wait_for(lambda: session.structureid == sid):
            return {'fixtureError': 'No Astrahus session'}
        controller = StructureController(sid)
        def services():
            return [{'name': item.name, 'id': item.serviceID, 'label': item.label,
                     'enabled': bool(controller.GetCurrentStateForService(item.serviceID).isEnabled),
                     'disable': item.disableButtonIfNotAvailable} for item in reversed(controller.GetServices())]
        before = services()
        commands = [str(slash.SlashCmd('/upwell %s' % cmd)) for cmd in [
            'core %d on' % sid, 'state %d shield_vulnerable' % sid, 'upkeep %d full_power' % sid,
            'service %d 20 online' % sid]]
        changed = wait_for(lambda: controller.GetCurrentStateForService(20).isEnabled)
        return dict(before=before, after=services(), changed=changed, commands=commands,
                    disabledLabel=GetByLabel('UI/Station/Lobby/Disabled'))
    except Exception as exc:
        return {'fixtureError': str(exc)}
    finally:
        if sid:
            slash.SlashCmd('/tr me %d' % station)
            wait_for(lambda: session.stationid == station)
            slash.SlashCmd('/upwell remove %d' % sid)

result = measure()
