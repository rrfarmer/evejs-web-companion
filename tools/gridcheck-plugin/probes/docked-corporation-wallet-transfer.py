from eve.client.script.ui.shared.neocom.wallet.transferMoneyWnd import TransferMoneyWnd
from localization import GetByLabel
from utillib import KeyVal

def observe():
    writes = []
    class Account(object):
        def GiveCash(self, *args, **kwargs):
            writes.append(('GiveCash', args, kwargs))

        def GiveCashFromCorpAccount(self, *args, **kwargs):
            writes.append(('GiveCashFromCorpAccount', args, kwargs))

    module = __import__(TransferMoneyWnd.__module__, fromlist=['TransferMoneyWnd'])
    namespace = module.__dict__
    account = Account()
    pilot = 140000003
    corp = 98000000
    fake = dict(session=KeyVal(charid=pilot, corpid=corp, corpAccountKey=1000),
                sm=KeyVal(RemoteSvc=lambda name: account), message_player=lambda text: None)
    saved = {name: namespace[name] for name in fake if name in namespace}
    layouts = []
    try:
        namespace.update(fake)
        for giver, source, receiver, target in [(pilot, None, corp, 1000),
                                                  (corp, 1000, pilot, None),
                                                  (corp, 1001, corp, 1002)]:
            wnd = KeyVal(fromID=giver, fromAccountKey=source, toID=receiver,
                         toAccountKey=target, walletSvc=KeyVal(GetWealth=lambda: 100,
                         GetCorpWealth=lambda key: 20 + (key or 1000) - 1000),
                         amount=KeyVal(GetValue=lambda: 1.25), reason=KeyVal(GetValue=lambda: 'Fixture'),
                         combo=KeyVal(GetValue=lambda: target), CloseByUser=lambda: None)
            TransferMoneyWnd._InitVariables.im_func(wnd)
            layouts.append([wnd.showFromAccount, wnd.showToAccount, wnd.maxISKvalue])
            TransferMoneyWnd.Confirm.im_func(wnd)
    finally:
        for name in fake:
            if name in saved:
                namespace[name] = saved[name]
            else:
                namespace.pop(name, None)
    return dict(station=session.stationid, layouts=layouts, writes=writes,
                labels=[GetByLabel('UI/Wallet/WalletWindow/' + label) for label in
                        ['DepositISK', 'WithdrawISK', 'TransferMoney', 'Account',
                         'SelectCorpOrChar', 'MenuTransferToCorp', 'MenuTransferFromCorp']])

result = observe()
