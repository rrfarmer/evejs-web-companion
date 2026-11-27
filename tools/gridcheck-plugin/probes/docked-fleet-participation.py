import blue
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid or FleetWindow.GetIfOpen():
        raise RuntimeError('A fresh docked pilot is required')
    changes = [('acceptsFleetWarp', fleet.TakesFleetWarp, fleet.SetAcceptsFleetWarpValue),
               ('acceptsConduitJumps', fleet.AcceptsConduitJumps, fleet.SetAcceptConduitJumpsValue),
               ('acceptsFleetRegroups', fleet.AcceptsFleetRegroups, fleet.SetAcceptRegroupValue)]
    try:
        fleet.CreateFleet()
        for _ in range(35):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        window = FleetWindow.Open()
        labels = [entry.GetText() for entry in window.GetFleetMenuTop() if entry is not None and entry.GetText().startswith('Accept ')]
        def state():
            return dict((key, read()) for key, read, _ in changes)
        initial = state()
        snapshots = []
        for key, read, write in changes:
            write(False)
            for _ in range(25):
                if read() is False:
                    break
                blue.pyos.synchro.SleepWallclock(120)
            snapshots.append(state())
        for key, read, write in changes:
            write(True)
        for _ in range(25):
            if state() == initial:
                break
            blue.pyos.synchro.SleepWallclock(120)
        return dict(build=3698585, station=session.stationid, labels=labels,
                    initial=initial, snapshots=snapshots, restored=state())
    finally:
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
