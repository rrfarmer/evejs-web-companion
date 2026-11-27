import blue
import evefleet
from eve.client.script.ui.shared.fleet.fleetwindow import FleetWindow
from localization import GetByLabel
from utillib import KeyVal


def observe():
    fleet = sm.GetService('fleet')
    if session.fleetid:
        raise RuntimeError('A fresh docked pilot is required')
    other = 140000002
    role = evefleet.fleetRoleMember
    higher = evefleet.fleetRoleSquadCmdr
    try:
        fleet.CreateFleet()
        for _ in range(40):
            if session.fleetid and session.charid in fleet.members:
                break
            blue.pyos.synchro.SleepWallclock(200)
        if not session.fleetid:
            raise RuntimeError('Fleet formation did not complete')
        initial = len(fleet.GetMemberHistory())
        window = FleetWindow.Open()
        fleet.OnFleetJoin(KeyVal(charID=other, role=role, job=0, wingID=-1, squadID=-1))
        fleet.OnFleetMemberChanged(other, session.fleetid, -1, -1, role, 0, {},
                                   -1, -1, higher, evefleet.fleetJobCreator, {}, False)
        fleet.OnFleetMemberChanged(other, session.fleetid, -1, -1, higher, evefleet.fleetJobCreator, {},
                                   -1, -1, higher, 0, {}, False)
        fleet.OnFleetLeave(other)
        rows = [[row.charID, row.event] for row in fleet.GetMemberHistory()]
        return dict(build=3698585, station=session.stationid, initial=initial, rows=rows,
                    filter=GetByLabel('UI/Fleet/FleetBroadcast/MemberHistory'))
    finally:
        FleetWindow.CloseIfOpen()
        if session.fleetid:
            fleet.LeaveFleet()


result = observe()
