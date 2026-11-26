import uthread2
from carbonui import const as uiconst
from carbonui.uicore import uicore
from chatutil import filter as chat_filter
from eveservices.xmppchat import GetChatService
from localization import GetByLabel
from neocom2.btnIDs import CHAT_ID


def observe():
    neocom = sm.GetService('neocom')
    node = next(item for item in neocom.mainBtnDataRoot.children if item.id == CHAT_ID)
    chat = GetChatService()
    room = chat.GetChannelByDisplayName('English Help')[0][0]
    was_joined = chat.IsJoined(room)
    window = None
    stack = None
    blink_setting = None
    original_patterns = chat_filter.BANNED_PATTERN, chat_filter.HIGHLIGHT_PATTERN
    original_focus = uicore.registry.GetFocus()
    try:
        if not was_joined:
            chat.JoinChannel(room, suppressMessage=True)
        for _ in range(20):
            window = chat.GetGroupChatWindow(room)
            if window:
                break
            uthread2.sleep(0.2)
        if window is None:
            raise RuntimeError('English Help window did not open')
        stack = window.GetStack()
        original_state = window.state
        original_blink = window.isBlinking
        stack_display = stack.display if stack else None
        caption = window.GetCaption()
        blink_setting = window._chat_notifications_enabled_setting
        original_setting = blink_setting.is_enabled()
        blink_label = GetByLabel('UI/Chat/BlinkOnNewActivity')
        blink_entry = next(item for item in window.GetMenu().GetEntries()
                           if getattr(item, 'setting', None) is blink_setting)
        blink_setting.enable()
        uicore.registry.SetFocus(None)
        window.SetNotBlinking()

        def sample():
            return dict(count=node.GetItemCount(), blinking=bool(window.isBlinking),
                        inStack=bool(window.InStack()), stackShown=bool(stack and stack.display))

        window.state = uiconst.UI_HIDDEN
        window._BlinkIfNeeded(session.charid, 'Gridcheck self activity')
        own = sample()
        window._BlinkIfNeeded(1, 'Gridcheck system activity')
        system = sample()
        if stack:
            stack.display = True
        window._BlinkIfNeeded(140000001, 'Gridcheck incoming activity')
        displayed = sample()
        if stack:
            stack.display = False
        window._BlinkIfNeeded(140000001, 'Gridcheck hidden activity')
        hidden = sample()
        neocom.CloseAllPanels()
        node.btnUI.ToggleNeocomPanel()
        row = next(row for row in node.btnUI._openNeocomPanel.main.children
                   if hasattr(row, 'btnData') and row.GetLabel() == caption)
        picker = bool(row.btnData.IsBlinking())
        window.SetNotBlinking()
        cleared = sample()
        blink_entry.setting.toggle()
        toggle_off = not blink_setting.is_enabled()
        chat_filter.UpdateChatFilterVariables([], ['gridcheck wake+'])
        window._BlinkIfNeeded(140000001, 'Gridcheck ordinary words')
        muted = sample()
        window._BlinkIfNeeded(140000001, 'prefixGRIDCHECK WAKE+suffix')
        highlighted = sample()
        window.SetNotBlinking()
        window._BlinkIfNeeded(140000001, 'prefixGRIDCHECK WAKEsuffix')
        literal = sample()
        blink_entry.setting.toggle()
        window._BlinkIfNeeded(140000001, 'Gridcheck ordinary words again')
        enabled = sample()
        return dict(station=session.stationid, caption=caption, own=own, system=system, displayed=displayed,
                    hidden=hidden, picker=picker, cleared=cleared, blinkLabel=blink_label,
                    menuLabel=blink_entry.GetTextDescriptive(), toggleOff=toggle_off, muted=muted,
                    highlighted=highlighted, literal=literal, enabled=enabled)
    finally:
        chat_filter.BANNED_PATTERN, chat_filter.HIGHLIGHT_PATTERN = original_patterns
        if blink_setting is not None:
            blink_setting.set(original_setting)
        neocom.CloseAllPanels()
        if window is not None:
            window.state = original_state
            if stack:
                stack.display = stack_display
            if original_blink:
                window.SetBlinking()
            else:
                window.SetNotBlinking()
        if not was_joined and chat.IsJoined(room):
            chat.LeaveChannel(room)
        if original_focus and not original_focus.destroyed:
            uicore.registry.SetFocus(original_focus)


result = observe()
