from eve.client.script.ui.control.eveEditPlainText import EditPlainText
from eve.client.script.ui.shared.pointerTool import favorites, link
from localization import GetByLabel
from utillib import KeyVal


def observe():
    service = sm.GetService('helpPointer')
    catalog = service.GetAllPointersByElementName()
    names = ('neocom.wallet', 'unique_ui_stationSvc_repairshop', 'unique_UI_walletTransactions')
    pointers = [catalog[name] for name in names]
    editor = EditPlainText()
    calls = []
    original = service.ActivateHelperPointer

    def record(name, source=0, displayTime=2):
        calls.append([name, source, displayTime])

    try:
        node = KeyVal(__guid__='listentry.PointerWndEntry', pointerObjects=pointers)
        editor.OnDropData(None, [node])
        markup = editor.GetValue()
        urls = [link.format_help_pointer_url(name) for name in names]
        service.ActivateHelperPointer = record
        for url in urls:
            link.handle_link(url)
        dragged = [KeyVal(__guid__='TextLink', url=url) for url in urls]
        return dict(station=session.stationid, enabled=link.are_pointer_links_enabled(),
                    urls=urls, labels=[pointer.labelLong or pointer.label for pointer in pointers],
                    markup=markup, calls=calls, hint=GetByLabel('UI/Help/HelpPointersTooltip'),
                    favoriteNames=list(favorites.FindUIElementsFromNodes(dragged)))
    finally:
        service.ActivateHelperPointer = original
        editor.Close()


result = observe()
