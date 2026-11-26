from carbonui.uicore import uicore
from eve.client.script.ui.shared.pointerTool.pointerWnd import PointerToolWnd
from globalConfig.getFunctions import ArePointerLinksActive
from localization import GetByLabel


def observe():
    existing = PointerToolWnd.GetIfOpen()
    uicore.cmd.OpenPointerWnd()
    window = PointerToolWnd.GetIfOpen()
    if not window:
        return dict(station=session.stationid, enabled=ArePointerLinksActive(sm.GetService('machoNet')), opened=False)
    original = window.filterEdit.GetValue()
    try:
        window.filterEdit.SetValue('', docallback=False)
        groups = window.GetScrollList()
        entries = {}
        for group in groups:
            rows = group.get('groupItems', [])
            if rows:
                entries[group.label] = [[node['uiElementName'], node['label']] for node in rows
                                        if node['label'] in ('Wallet', 'Inventory', 'Market', 'Chat', 'Fitting',
                                            'Repair Shop', 'Regional Market', 'Ship Hangar', 'Item Hangar', 'Undock')]
        window.filterEdit.SetValue('wallet', docallback=False)
        filtered = window.GetScrollList()
        return dict(station=session.stationid, enabled=True, opened=True, title=window.GetCaption(),
                    size=[window.width, window.height],
                    defaultFrames=bool(settings.user.ui.Get('poingerWnd_showFrames', False)),
                    groups=[group.label for group in groups], entries=entries,
                    filtered=[[group.label, [node['label'] for node in group.get('groupItems', [])]] for group in filtered],
                    shortcut=window.GetShortcutText(),
                    labels=[GetByLabel(path) for path in ('UI/Help/PointerWndShowHighlights',
                            'UI/HelpPointers/Wnd/FavoriteGroup', 'UI/Help/PointerWndNeocomHeader',
                            'UI/Help/PointerWndStationServices', 'UI/Common/NothingFound')])
    finally:
        if existing:
            window.filterEdit.SetValue(original, docallback=False)
            window.LoadContent()
        else:
            window.Close()


result = observe()
