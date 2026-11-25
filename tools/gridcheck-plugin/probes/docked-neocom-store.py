import blue
from neocom2.btnIDs import AURUM_STORE_ID


def observe():
    neocom = sm.GetService('neocom')
    views = sm.GetService('viewState')
    store_name = 'virtual_goods_store'
    if views.IsViewActive(store_name):
        return {'alreadyOpen': True}
    try:
        store = sm.RemoteSvc('storeManager')
        panel = neocom.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        entry = next(row for row in rows if row.btnData.id == AURUM_STORE_ID)
        snapshot = {'station': session.stationid, 'label': entry.GetLabel(), 'index': rows.index(entry),
                    'command': entry.btnData.cmdName, 'icon': entry.btnData.iconPath,
                    'offers': len(store.get_offers(4) or []), 'categories': len(store.get_categories(4) or [])}
        entry.OnClick()
        for _ in xrange(50):
            if views.IsViewActive(store_name):
                break
            blue.synchro.SleepWallclock(100)
        snapshot['opened'] = bool(views.IsViewActive(store_name))
        return snapshot
    finally:
        neocom.CloseAllPanels()
        if views.IsViewActive(store_name):
            views.CloseSecondaryView()


result = observe()
