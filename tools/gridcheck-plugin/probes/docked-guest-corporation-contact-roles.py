"""Inspect client corporation-contact offers for visible guests and role projections."""
from eve.common.lib import appConst
from menucheckers.characterCheckers import CharacterChecker
from menucheckers.sessionChecker import SessionChecker


class ProjectedSession:
    def __init__(self, role):
        self.corprole = role

    def __getattr__(self, name):
        return getattr(session, name)


def offers(checker):
    return {
        'add': checker.OfferAddCorpContact(),
        'remove': checker.OfferRemoveCorpContact(),
        'edit': checker.OfferEditCorpContact(),
    }


location_service = 'station' if session.stationid else 'structureGuests'
guests = sorted(sm.GetService(location_service).GetGuests())
roles = [('member', 0), ('director', appConst.corpRoleDirector), ('diplomat', appConst.corpRoleDiplomat)]
rows = []
for pilot_id in guests:
    live = CharacterChecker(pilot_id, False, session, sm)
    matrix = []
    for name, role in roles:
        projected = SessionChecker(ProjectedSession(role), sm)
        matrix.append({'role': name,
                       'single': offers(CharacterChecker(pilot_id, False, projected, sm)),
                       'multi': offers(CharacterChecker(pilot_id, True, projected, sm))})
    rows.append({'pilot': pilot_id, 'self': live.IsMe(), 'npc': live.IsNPC(),
                 'inBook': live.IsInCorpAddressBook(), 'live': offers(live), 'projected': matrix})

result = {'pilot': session.charid, 'station': session.stationid, 'structure': session.structureid,
          'corporationRole': str(session.corprole), 'rows': rows}
