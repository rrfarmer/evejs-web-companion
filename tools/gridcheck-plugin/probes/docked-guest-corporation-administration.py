"""Read corporation administration offers for docked Guests using native checkers."""
from utillib import KeyVal
from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
from eve.common.lib import appConst
from eve.client.script.ui.services.menuMerge import MergeMenus
from menu import MenuLabel
from menucheckers.characterCheckers import CharacterChecker
from menucheckers.sessionChecker import SessionChecker


class ProjectedSession(SessionChecker):
    def __init__(self, pilot, same_corp, service_manager):
        SessionChecker.__init__(self, pilot, service_manager)
        self.same_corp = same_corp

    def isPilotInSameCorpAs(self, pilot_id):
        return self.same_corp


class ProjectedChecker(CharacterChecker):
    def __init__(self, pilot_id, multi, projected, service_manager, blocked):
        CharacterChecker.__init__(self, pilot_id, multi, projected, service_manager)
        self.blocked = blocked

    def GetBlockedRoles(self):
        return self.blocked


def offers(checker):
    return {
        'allow': checker.OfferAllowCorpRoles(),
        'cash': checker.OfferTransferCorpCash(),
        'award': checker.OfferAwardCorpMemberDecoration(),
        'invite': checker.OfferSendCorpInvite(),
        'expel': checker.OfferExpelCorpMember(),
    }


def menu_entry(path):
    return [MenuLabel(path), lambda: None]


def presented_entries(raw):
    menu = CreateMenuDataFromRawTuples(raw)
    return [None if entry is None else {'path': entry.GetLabelPath(), 'label': unicode(entry.GetTextDescriptive())}
            for entry in menu.GetEntries()]


location_service = 'station' if session.stationid else 'structureGuests'
guests = sorted(sm.GetService(location_service).GetGuests())
authority = appConst.corpRoleDirector | appConst.corpRoleAccountant | appConst.corpRolePersonnelManager
cases = [
    ('member', 0, True, False),
    ('blocked-member', 0, True, True),
    ('authority-own-corp', authority, True, False),
    ('authority-other-corp', authority, False, False),
]
rows = []
for pilot_id in guests:
    live = CharacterChecker(pilot_id, False, session, sm)
    matrix = []
    for name, role, same_corp, blocked in cases:
        pilot = KeyVal(charid=session.charid, corpid=98000000, corprole=role)
        projection = ProjectedSession(pilot, same_corp or live.IsMe(), sm)
        matrix.append({'case': name,
                       'single': offers(ProjectedChecker(pilot_id, False, projection, sm, blocked)),
                       'multi': offers(ProjectedChecker(pilot_id, True, projection, sm, blocked))})
    rows.append({'pilot': pilot_id, 'self': live.IsMe(), 'live': offers(live), 'projected': matrix})

paths = [
    'UI/Commands/ShowInfo', 'UI/Commands/CapturePortrait',
    'UI/Corporations/Common/EditCorpMember', 'UI/Corporations/Common/AllowCorpRoles',
    'UI/Corporations/Common/TransferCorpCash', 'UI/Corporations/Common/ExpelCorpMember',
    'UI/Corporations/Common/ExpelCorpMembers', 'UI/Corporations/Common/AwardCorpMemberDecoration',
    'UI/Corporations/Common/SendCorpInvite',
]
award_path = 'UI/Corporations/Common/AwardCorpMemberDecoration'
multi_award = presented_entries(MergeMenus([[[MenuLabel(award_path), lambda: None, [pilot_id]]] for pilot_id in guests]))
result = {'pilot': session.charid, 'station': session.stationid, 'structure': session.structureid,
          'corporationRole': str(session.corprole), 'rows': rows, 'multiAward': multi_award,
          'presented': presented_entries([menu_entry(path) for path in paths])}
