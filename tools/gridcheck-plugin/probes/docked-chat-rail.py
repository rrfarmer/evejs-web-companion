import uthread2
from eveservices.xmppchat import GetChatService
from neocom2.btnIDs import CHAT_ID
from xmppchatclient.xmppchatchannels import XmppChatChannels


def observe():
    service = sm.GetService('neocom')
    node = next(node for node in service.mainBtnDataRoot.children if node.id == CHAT_ID)
    button = node.btnUI
    was_open = XmppChatChannels.GetIfOpen()
    chat = GetChatService()
    room = chat.GetChannelByDisplayName('English Help')[0][0]
    was_joined = chat.IsJoined(room)

    def panel_rows():
        service.CloseAllPanels()
        button.ToggleNeocomPanel()
        return [row for row in button._openNeocomPanel.main.children if hasattr(row, 'btnData')]

    try:
        rows = panel_rows()
        evidence = dict(station=session.stationid, labels=[row.GetLabel() for row in rows],
                        heights=[row.height for row in rows],
                        windows=[window.name for window in node._GetOpenChatWindows()],
                        firstCommand=rows[0].btnData.cmdName)
        if not was_joined:
            chat.JoinChannel(room, suppressMessage=True)
            for _ in range(20):
                if chat.IsJoined(room) and any(window.GetCaption() == 'English Help' for window in node._GetOpenChatWindows()):
                    break
                uthread2.sleep(0.2)
        evidence['joinedLabels'] = [row.GetLabel() for row in panel_rows()]
        service.CloseAllPanels()
        menu = button.GetMenu()
        menu[0][1](*menu[0][2])
        evidence.update(context=[item[0] for item in menu if isinstance(item, tuple)],
                        opensDirectory=bool(XmppChatChannels.GetIfOpen()))
        return evidence
    finally:
        service.CloseAllPanels()
        if not was_joined:
            chat.LeaveChannel(room)
        window = XmppChatChannels.GetIfOpen()
        if window and not was_open:
            window.Close()


result = observe()
