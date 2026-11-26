from eve.client.script.ui.services import standingsvc
from eve.client.script.ui.shared.fleet.fleetfinder import PanelFleetFinder
from localization import GetByLabel
from utillib import KeyVal


class EntryPanel(object):
    SetInfoCont = None


def observe():
    service = sm.GetService('standing')
    original_sm = getattr(standingsvc, 'sm', sm)
    had_sm = hasattr(standingsvc, 'sm')
    contacts = {}
    cases = [(-10, 140000001), (None, 140000002), (4.99, 140000003),
             (5, 140000004), (9.99, 140000005), (10, 140000006)]

    class Book(object):
        def GetContacts(self):
            return KeyVal(contacts=contacts)

    class Services(object):
        def GetService(self, name):
            return Book() if name == 'addressbook' else original_sm.GetService(name)

    try:
        standingsvc.sm = Services()
        rows = []
        for value, char_id in cases:
            if value is not None:
                contacts[char_id] = KeyVal(relationshipID=value)
            standing = service.GetStanding(session.charid, char_id)
            leader = KeyVal(charID=char_id, corpID=session.corpid, allianceID=session.allianceid,
                            warFactionID=None, securityStatus=0)
            advert = KeyVal(fleetID=1, leader=leader, hideInfo=True, advertJoinLimit=None,
                            numMembers=2, solarSystemID=None, fleetName='Fleet',
                            description='', standing=standing)
            includes = [threshold for threshold in (None, 5, 10)
                        if PanelFleetFinder.GetFleetEntry.__func__(EntryPanel(), advert, None, None, threshold, False)]
            rows.append({'id': char_id, 'contact': value, 'standing': standing, 'thresholds': includes})
        return {'station': session.stationid, 'cases': rows,
                'options': [[GetByLabel('UI/Standings/AnyStanding'), None],
                            [GetByLabel('UI/Standings/GoodStanding'), 5],
                            [GetByLabel('UI/Standings/ExcellentStanding'), 10]]}
    finally:
        if had_sm:
            standingsvc.sm = original_sm
        else:
            del standingsvc.sm


result = observe()
