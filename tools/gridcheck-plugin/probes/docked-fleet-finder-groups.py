import evefleet
from eve.client.script.ui.shared.fleet import fleetfinder
from localization import GetByLabel
from utillib import KeyVal


class EntryPanel(object):
    SetInfoCont = None

    def IsOpenToMyGroups(self, advert):
        return fleetfinder.PanelFleetFinder.IsOpenToMyGroups.__func__(self, advert)


def observe():
    original = getattr(fleetfinder, 'session', session)
    had_session = hasattr(fleetfinder, 'session')
    membership = KeyVal(charid=session.charid, corpid=session.corpid, allianceid=99000000, warfactionid=500001)
    other_corp = 1000046 if membership.corpid == 1000045 else 1000045
    public = evefleet.INVITE_PUBLIC_OPEN
    cases = [
        ('unrestricted', public, None, {}),
        ('negative', public, -1, {}),
        ('neutral', public, 0, {}),
        ('positive', public, 0.1, {}),
        ('own', public, None, {'charID': membership.charid}),
        ('corp', public | evefleet.INVITE_CORP, None, {'corpID': membership.corpid}),
        ('alliance', public | evefleet.INVITE_ALLIANCE, None, {'allianceID': membership.allianceid}),
        ('militia', public | evefleet.INVITE_MILITIA, None, {'warFactionID': membership.warfactionid}),
        ('other group', public | evefleet.INVITE_CORP, None, {}),
        ('approval', evefleet.INVITE_PUBLIC, None, {}),
        ('group only', evefleet.INVITE_CORP, None, {'corpID': membership.corpid}),
        ('membership without invite', public, None, {'corpID': membership.corpid}),
    ]
    try:
        fleetfinder.session = membership
        rows = []
        for name, scope, minimum, leader_overrides in cases:
            fields = dict(charID=140000002, corpID=other_corp, allianceID=None,
                          warFactionID=None, securityStatus=0)
            fields.update(leader_overrides)
            advert = KeyVal(fleetID=1, leader=KeyVal(**fields), hideInfo=True,
                            advertJoinLimit=None, numMembers=2, solarSystemID=None,
                            fleetName=name, description='', inviteScope=scope,
                            public_minStanding=minimum)
            entry = fleetfinder.PanelFleetFinder.GetFleetEntry.__func__
            rows.append(dict(name=name, scope=scope, minimum=minimum, leader=leader_overrides,
                             unchecked=bool(entry(EntryPanel(), advert, None, None, None, False)),
                             checked=bool(entry(EntryPanel(), advert, None, None, None, True))))
        return dict(station=session.stationid, cases=rows,
                    label=GetByLabel('UI/Fleet/FleetRegistry/ShowGroupAndHighStandingsFleets'))
    finally:
        if had_session:
            fleetfinder.session = original
        else:
            del fleetfinder.session


result = observe()
