from eve.client.script.ui.shared.neocom.wallet import walletUtil
from eve.client.script.ui.shared import marketSvc
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal

def observe():
    roles = {}
    namespace = walletUtil.__dict__
    saved = namespace.get('session')
    had_session = 'session' in namespace
    cases = [('accountant', appConst.corpRoleAccountant),
             ('junior', appConst.corpRoleJuniorAccountant),
             ('trader', appConst.corpRoleTrader),
             ('traderTake', appConst.corpRoleTrader | appConst.corpRoleAccountCanTake2)]
    try:
        for name, mask in cases:
            namespace['session'] = KeyVal(corprole=mask, corpAccountKey=1001)
            roles[name] = dict(wallet=walletUtil.HaveAccessToCorpWallet(),
                               allDivisions=walletUtil.AmAccountantOrJuniorAccountant(),
                               market=walletUtil.AmAccountantOrTrader(),
                               take=list(walletUtil.GetAccessibleCorpWalletDivisionIDs()))
    finally:
        if had_session:
            namespace['session'] = saved
        else:
            namespace.pop('session', None)
    get_row = sm.GetService('market')._GetCorpTransactionKeyVal
    raw = dict(buyerAccountID=1001, sellerAccountID=1000, buyerID=140000003,
               sellerID=140000001, price=12.5, quantity=2)
    rows = []
    for key in [1001, 1000]:
        row = get_row(KeyVal(accountID=key, **raw))
        rows.append([row.isBuyTransaction, row.characterID, row.clientID, row.totalPrice])
    path = 'UI/Wallet/WalletWindow/'
    labels = [GetByLabel(path + name) for name in
              ['MarketTransactions', 'Division', 'Member', 'ColHeaderWho',
               'ColHeaderWalletDivision', 'MenuViewMarketTransactions']]
    return dict(station=session.stationid, roles=roles, labels=labels, rows=rows)

result = observe()
