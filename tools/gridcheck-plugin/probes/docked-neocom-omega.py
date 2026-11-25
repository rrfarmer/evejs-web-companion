import blue
from eve.client.script.ui.omega.upsell.omegaUpsellWindow import OmegaUpsellWindow
from neocom2.btnIDs import OMEGA_UPSELL
from omega.client.clone_grade_svc import get_clone_grade_svc


def observe():
    neocom = sm.GetService('neocom')
    if OmegaUpsellWindow.GetIfOpen():
        return {'alreadyOpen': True}
    try:
        panel = neocom.ShowEveMenu()
        rows = [entry for entry in panel.main.children if hasattr(entry, 'btnData')]
        entry = next(row for row in rows if row.btnData.id == OMEGA_UPSELL)
        store = sm.RemoteSvc('storeManager')
        categories = store.get_categories(4) or []
        gametime = [category for category in categories if 'gametime' in (category.get('tags') or [])]
        observation = {'station': session.stationid, 'index': rows.index(entry), 'label': entry.GetLabel(),
                       'command': entry.btnData.cmdName, 'icon': entry.btnData.iconPath,
                       'omega': bool(get_clone_grade_svc().is_omega_without_grace_period()),
                       'gametime': [{'id': row['id'], 'name': row['name']} for row in gametime]}
        entry.OnClick()
        for _ in xrange(60):
            window = OmegaUpsellWindow.GetIfOpen()
            if window and window.page_id:
                break
            blue.synchro.SleepWallclock(100)
        if window:
            observation.update({'windowID': window.default_windowID, 'page': window.page_id})
        return observation
    finally:
        neocom.CloseAllPanels()
        window = OmegaUpsellWindow.GetIfOpen()
        if window:
            window.Close()


result = observe()
