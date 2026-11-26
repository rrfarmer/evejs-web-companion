from eve.client.script.ui.shared.neocom.evemail import NewNewMessage
from utillib import KeyVal


def observe():
    window = NewNewMessage.Open(windowID='codexMailComposeLinkProbe')
    try:
        editor = window.messageedit
        editor.SetValue('left right')
        editor.SetCursorPos(4)
        editor.OnDropDataDelegate(None, [
            KeyVal(__guid__='TextLink', displayText='First & second', url='showinfo:35832//1030000000000'),
            KeyVal(__guid__='TextLink', displayText='Third < fourth', url='showinfo:35832//1030000000001')])
        return dict(station=session.stationid, body=editor.GetValue(), cursor=editor.globalCursorPos,
                    editor=editor.__class__.__name__, maximum=editor.maxletters)
    finally:
        window.Close()


result = observe()
