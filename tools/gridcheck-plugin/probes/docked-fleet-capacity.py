import blue
import evefleet
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid or FleetWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    try:
        fleet.CreateFleet()
        for _ in range(35):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        labels = [e.GetText() for e in window.GetFleetMenuTop() if e is not None and
                  e.GetText() in ('Set Max Fleet Size', 'Allow Free-Move')]
        before = [fleet.fleet.GetFleetMaxSize(), bool(fleet.GetOptions().isFreeMove)]
        fleet.fleet.SetFleetMaxSize(17)
        fleet.SetOptions(isFreeMove=True)
        for _ in range(25):
            if fleet.GetOptions().isFreeMove:
                break
            blue.pyos.synchro.SleepWallclock(120)
        changed = [fleet.fleet.GetFleetMaxSize(), bool(fleet.GetOptions().isFreeMove)]
        fleet.fleet.SetFleetMaxSize(before[0])
        fleet.SetOptions(isFreeMove=before[1])
        for _ in range(25):
            if bool(fleet.GetOptions().isFreeMove) == before[1]:
                break
            blue.pyos.synchro.SleepWallclock(120)
        return dict(build=3698585, station=session.stationid, labels=labels, bounds=[1, evefleet.MAX_MEMBERS_IN_FLEET],
                    before=before, changed=changed, restored=[fleet.fleet.GetFleetMaxSize(), bool(fleet.GetOptions().isFreeMove)])
    finally:
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
