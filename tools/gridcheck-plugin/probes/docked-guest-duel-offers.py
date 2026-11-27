"""Read the native duel offer checks for the current docked Guests roster."""
from menucheckers.characterCheckers import CharacterChecker
from menucheckers.sessionChecker import SessionChecker

location_service = 'station' if session.stationid else 'structureGuests'
guests = sm.GetService(location_service).GetGuests()
session_checker = SessionChecker(session, sm)
map_service = sm.GetService('map')
rows = []
for pilot_id in sorted(guests):
    checker = CharacterChecker(pilot_id, False, session_checker, sm)
    rows.append({
        'pilot': pilot_id,
        'self': checker.IsMe(),
        'npc': checker.IsNPC(),
        'engaged': bool(checker.isPilotInLimitedEngagementWith(pilot_id)),
        'offer': checker.OfferDuelMenuEntry(),
    })
result = {
    'pilot': session.charid,
    'station': session.stationid,
    'structure': session.structureid,
    'securityLookupSystem': session.solarsystemid,
    'dockSystem': session.solarsystemid2,
    'effectiveSecurity': map_service.GetSecurityStatus(session.solarsystemid),
    'dockSystemSecurity': map_service.GetSecurityStatus(session.solarsystemid2),
    'zeroSecurityClass': session_checker.IsInZeroSec(),
    'rows': rows,
}
