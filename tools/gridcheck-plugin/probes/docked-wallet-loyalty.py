from eve.client.script.ui.shared.neocom.wallet.panels.personal.lpPanel import LPEntry, get_corporation_faction_id
from eve.common.lib.appConst import corpHeraldry
from localization import GetByLabel


def observe():
    wallet = sm.GetService('loyaltyPointsWalletSvc')
    store = sm.GetService('lpstore')
    balances = sorted(wallet.GetAllCharacterLPBalancesExcludingEvermarks())
    samples = []
    for issuer in [1000035, 1000125, corpHeraldry]:
        try:
            location = store.GetNearestDockableWithLPStoreForCorp(issuer)
        except Exception:
            location = None
        samples.append([issuer, get_corporation_faction_id(issuer), location])
    return dict(station=session.stationid, balances=balances, samples=samples, headers=list(LPEntry.GetHeaders()),
                loyaltyTile=GetByLabel('UI/Wallet/WalletWindow/TabLPCorpNumber', numLPCorps=2),
                evermarks=wallet.GetCharacterEvermarkBalance(),
                evermarkTile=GetByLabel('UI/Wallet/WalletWindow/EvermarkAmount', everMarkAmount=4321),
                allFactions=GetByLabel('UI/Wallet/WalletWindow/AllFactions'))


result = observe()
