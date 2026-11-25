# Read the native Travel To predicate, destination arguments and docked refusal.
from localization import GetByLabel
from menucheckers.celestialCheckers import CelestialChecker
from eve.client.script.parklife.fleetSvc import FleetSvc
from utillib import KeyVal

system_id = 30000208
def checker(member, waypoint):
    return KeyVal(cache={}, session=KeyVal(IsPilotFleetMember=lambda: member),
                  CanBeWaypoint=lambda: waypoint, IsStation=False,
                  IsSolarsystem=lambda: True, item=KeyVal(typeID=5))

available = CelestialChecker.OfferBroadcastTravelTo.im_func
calls = []
FleetSvc.SendBroadcast_TravelTo.im_func(KeyVal(SendGlobalBroadcast=lambda *args: calls.append(args)), system_id, 5)
try:
    FleetSvc.CheckIsInFleet.im_func(KeyVal(fleet=object()), inSpace=True)
    refusal = None
except UserError as error:
    refusal = error.msg
result = {'label': GetByLabel('UI/Fleet/FleetBroadcast/Commands/BroadcastTravelTo'),
          'member': available(checker(True, True)), 'solo': available(checker(False, True)),
          'notWaypoint': available(checker(True, False)), 'arguments': calls,
          'refusal': refusal, 'station': session.stationid}
