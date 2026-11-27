"""Read native alliance contact offers and project the role and executor combinations."""
from utillib import KeyVal
from eve.common.lib import appConst
from menucheckers.characterCheckers import CharacterChecker
from menucheckers.sessionChecker import SessionChecker


class ProjectedServices:
    def __init__(self, executor, saved):
        self.executor = executor
        self.saved = saved

    def GetService(self, name):
        if name in ('alliance', 'addressbook'):
            return self
        return sm.GetService(name)

    def GetAlliance(self, alliance_id):
        return KeyVal(executorCorpID=self.executor)

    def IsInAddressBook(self, pilot_id, scope):
        return scope == 'alliancecontact' and self.saved


def offers(checker):
    return {'add': checker.OfferAddAllianceContact(),
            'remove': checker.OfferRemoveAllianceContact(),
            'edit': checker.OfferEditEditAllianceContact()}


location_service = 'station' if session.stationid else 'structureGuests'
guests = sorted(sm.GetService(location_service).GetGuests())
cases = [
    ('no-alliance', appConst.corpRoleDirector, None, session.corpid),
    ('executor-member', 0, 99000000, session.corpid),
    ('member-corp-director', appConst.corpRoleDirector, 99000000, session.corpid + 1),
    ('executor-director', appConst.corpRoleDirector, 99000000, session.corpid),
    ('executor-diplomat', appConst.corpRoleDiplomat, 99000000, session.corpid),
]
rows = []
for pilot_id in guests:
    live = CharacterChecker(pilot_id, False, session, sm)
    matrix = []
    for name, role, alliance_id, executor in cases:
        projected = KeyVal(charid=session.charid, corpid=session.corpid, corprole=role, allianceid=alliance_id)
        for saved in (False, True):
            services = ProjectedServices(executor, saved)
            checker_session = SessionChecker(projected, services)
            matrix.append({'case': name, 'saved': saved,
                           'single': offers(CharacterChecker(pilot_id, False, checker_session, services)),
                           'multi': offers(CharacterChecker(pilot_id, True, checker_session, services))})
    rows.append({'pilot': pilot_id, 'self': live.IsMe(), 'live': offers(live), 'projected': matrix})

result = {'pilot': session.charid, 'station': session.stationid, 'structure': session.structureid,
          'alliance': session.allianceid, 'corporationRole': str(session.corprole), 'rows': rows}
