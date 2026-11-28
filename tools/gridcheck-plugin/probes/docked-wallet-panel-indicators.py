import uthread2
from eve.client.script.ui.shared.neocom.wallet import walletConst
from eve.client.script.ui.shared.neocom.wallet.walletWnd import WalletWindow


def observe():
    existing = WalletWindow.GetIfOpen()
    if existing:
        return dict(station=session.stationid, error='Close the existing Wallet before probing')

    wallet = WalletWindow.Open(tabID=walletConst.PANEL_PERSONAL)
    try:
        personal = wallet.personalWallet
        personal.Load()
        personal.SelectTab(walletConst.PANEL_PERSONALISK)
        isk_panel = personal.iskPanel
        isk_panel.OnTabSelect()
        isk_panel.tabGroup.SelectByID(walletConst.PANEL_OVERVIEW)
        isk = personal.tabGroup.GetTabByID(walletConst.PANEL_PERSONALISK)
        transactions = isk_panel.tabGroup.GetTabByID(walletConst.PANEL_TRANSACTIONS)

        def snapshot():
            return dict(isk=isk._activity_indicator.activity_level,
                        transactions=transactions._activity_indicator.activity_level,
                        header=wallet.tabGroup.GetTabByID(walletConst.PANEL_PERSONAL)._activity_indicator.activity_level)

        rows = {}
        WalletWindow.BlinkPersonalWallet(walletConst.PANEL_TRANSACTIONS)
        rows['selected ISK'] = snapshot()
        personal.SelectTab(walletConst.PANEL_LP)
        WalletWindow.BlinkCorpWallet()
        rows['corporation dispatch'] = snapshot()
        WalletWindow.BlinkPersonalWallet(walletConst.PANEL_TRANSACTIONS)
        rows['inactive ISK'] = snapshot()
        uthread2.sleep(5.25)
        rows['settled'] = snapshot()
        personal.SelectTab(walletConst.PANEL_PERSONALISK)
        rows['acknowledged'] = snapshot()
        return dict(station=session.stationid, rows=rows)
    finally:
        wallet.Close()


result = observe()
