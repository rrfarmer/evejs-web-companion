from eve.client.script.ui.shared.neocom.wallet import walletUtil
from eve.common.lib import appConst
from localization import GetByLabel
from utillib import KeyVal

def observe():
    choices = []
    writes = []
    selection = [None]
    class Corporation(object):
        def GetCorpAccountName(self, key):
            return {1001: 'Ward', 1003: 'Fleet'}[key]

        def SetAccountKey(self, key):
            writes.append(key)

    corp = Corporation()
    def pick(rows, **kwargs):
        choices.append(dict(rows=rows, caption=kwargs['caption']))
        return selection[0]

    namespace = walletUtil.__dict__
    fake = dict(session=KeyVal(corprole=appConst.corpRoleAccountant |
                              appConst.corpRoleAccountCanTake2 | appConst.corpRoleAccountCanTake4,
                              corpAccountKey=None),
                sm=KeyVal(GetService=lambda name: corp),
                ListWnd=pick)
    saved = {name: namespace[name] for name in fake if name in namespace}
    try:
        namespace.update(fake)
        walletUtil.SelectWalletDivision()
        selection[0] = ('Fleet', 1003)
        walletUtil.SelectWalletDivision()
        walletUtil.CheckSetDefaultWalletDivision()
    finally:
        for name in fake:
            if name in saved:
                namespace[name] = saved[name]
            else:
                namespace.pop(name, None)
    path = 'UI/Wallet/WalletWindow/'
    return dict(station=session.stationid, choices=choices, writes=writes,
                labels=[GetByLabel('Achievements/UI/active')] +
                       [GetByLabel(path + name) for name in
                        ['SelectDivision', 'ChangeDivision', 'MenuSetActiveWallet']])

result = observe()
