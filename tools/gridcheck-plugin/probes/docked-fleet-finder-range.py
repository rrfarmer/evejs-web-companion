from eve.client.script.ui.shared.fleet.fleetfinder import PanelFleetFinder
from localization import GetByLabel
from utillib import KeyVal


class EntryPanel(object):
    SetInfoCont = None


def observe():
    pathfinder = sm.GetService('clientPathfinderService')
    map_svc = sm.GetService('map')
    leader = KeyVal(charID=session.charid, corpID=session.corpid, allianceID=session.allianceid,
                    warFactionID=None, securityStatus=0)
    cases = []
    nearby = pathfinder.GetSystemsWithinJumpRange(session.solarsystemid2, 5, 11)
    boundary_systems = [sorted(nearby[jumps])[0] for jumps in (5, 10, 11) if nearby.get(jumps)]
    for system in [session.solarsystemid2, 30000142, 30000121, 30002187, 31000001, None] + boundary_systems:
        advert = KeyVal(fleetID=1, leader=leader, hideInfo=system is None, advertJoinLimit=None,
                        numMembers=2, solarSystemID=system, fleetName='Fleet', description='')
        jumps = None
        if system:
            jumps = int(pathfinder.GetJumpCountFromCurrent(system))
            advert.numJumps = jumps
            advert.regionID = map_svc.GetParent(map_svc.GetParent(system))
        includes = [value for value in (None, 5, 10, -1)
                    if PanelFleetFinder.GetFleetEntry.__func__(EntryPanel(), advert, None, value, None, False)]
        cases.append({'system': system, 'jumps': jumps, 'ranges': includes})
    return {
        'station': session.stationid,
        'options': [[GetByLabel('UI/Agency/ContentOfAnyDistance'), None],
                    [GetByLabel('UI/Common/WithinJumps', numJumps=5), 5],
                    [GetByLabel('UI/Common/WithinJumps', numJumps=10), 10],
                    [GetByLabel('UI/Common/LocationTypes/Region'), -1]],
        'cases': cases,
    }


result = observe()
