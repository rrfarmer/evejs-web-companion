from eve.client.script.ui.shared.neocom.wallet.panels.personal.lpPanel import get_corporation_faction_id
from eve.common.script.util.facwarCommon import GetFwFactionIDForNpcCorp
from loyaltypoints.lpUtil import get_hardcoded_lp_stations_for_corp
from resourcewars.common.const import RW_LP_CORPORATIONS


def observe():
    system = session.solarsystemid2
    stores = sm.GetService('lpstore')
    insurgency = sm.GetService('insurgencyCampaignSvc')
    resource_wars = sm.RemoteSvc('RWManager').get_closest_rw_stations(system)
    issuers = list(RW_LP_CORPORATIONS) + [1000436, 1000437]
    rows = []
    for issuer in issuers:
        faction = GetFwFactionIDForNpcCorp(issuer)
        rows.append(dict(issuer=issuer, faction=get_corporation_faction_id(issuer),
                         militia=faction, nearest=stores.GetNearestDockableWithLPStoreForCorp(issuer),
                         hardcoded=get_hardcoded_lp_stations_for_corp(issuer),
                         fob=insurgency.GetActiveFobStructureIdAndSystemIdForFaction(faction) if faction else None))
    return dict(station=session.stationid, system=system, resourceWars=sorted(resource_wars.items()), rows=rows)


result = observe()
