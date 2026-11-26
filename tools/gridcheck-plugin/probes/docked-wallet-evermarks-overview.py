import evetypes
from eve.client.script.ui.shared.agencyNew.contentGroups.contentGroupConst import contentGroupMissionAgentsHeraldry
from eve.client.script.ui.shared.info.infoConst import TAB_STATIONS
from eve.common.lib import appConst
from localization import GetByLabel


def observe():
    corp = appConst.corpHeraldry
    systems = sm.RemoteSvc('config').GetStationSolarSystemsByOwner(corp)
    stations = []
    for system in systems:
        for entry in cfg.GetLocationsLocalBySystem(system.solarSystemID, False):
            if evetypes.GetGroupID(entry.typeID) != appConst.groupStation:
                continue
            if getattr(cfg.stations.GetIfExists(entry.itemID), 'ownerID', None) == corp:
                stations.append((entry.itemID, system.solarSystemID, cfg.evelocations.Get(entry.itemID).name))
    return dict(station=session.stationid, corporation=corp, agencyGroup=contentGroupMissionAgentsHeraldry,
                tab=TAB_STATIONS, stations=sorted(stations),
                earn=GetByLabel('UI/Wallet/WalletWindow/EverMarkEarn'),
                spend=GetByLabel('UI/Wallet/WalletWindow/EverMarkSpend'))


result = observe()
