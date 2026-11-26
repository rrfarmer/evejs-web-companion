from eve.client.script.ui.shared.neocom.wallet import walletUtil
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal


def read_access():
    return dict(isk=walletUtil.HaveAccessToCorpWallet(),
                journal=walletUtil.AmAccountantOrJuniorAccountant(),
                lp=walletUtil.HaveAccessToCorpLPWallet(),
                em=walletUtil.HaveAccessToCorpEMWallet())


def observe():
    cases = [('none', 0), ('accountant', appConst.corpRoleAccountant),
             ('junior', appConst.corpRoleJuniorAccountant), ('division', appConst.corpRoleAccountCanTake1),
             ('director', appConst.corpRoleDirector), ('brand', appConst.corpRoleBrandManager)]
    live = read_access()
    roles = {}
    namespace = walletUtil.__dict__
    had_session = 'session' in namespace
    previous = namespace.get('session')
    try:
        for name, mask in cases:
            namespace['session'] = KeyVal(corprole=mask, corpAccountKey=1000)
            roles[name] = read_access()
    finally:
        if had_session:
            namespace['session'] = previous
        else:
            namespace.pop('session', None)
    paths = ['MyWallet', 'CorporationWallet', 'TabTransactions', 'TabWalletDivisions']
    labels = [GetByLabel('UI/Wallet/WalletWindow/' + path) for path in paths]
    labels.append(GetByLabel('UI/Corporations/CorpUIHome/Shares'))
    return dict(station=session.stationid, live=live, roles=roles, labels=labels)


result = observe()
