from eve.client.script.ui.structure.accessGroups import groupInfoWnd
from ownergroups.client import link
from localization import GetByLabel
from utillib import KeyVal


def observe():
    group_id = 123
    url = link.format_access_group_url(group_id)
    window_id = 'groupInfoWnd_%s' % group_id
    original = groupInfoWnd.GetGroupInfo
    group = KeyVal(groupID=group_id, creatorID=session.charid, name='Gridcheck Access List',
                   description='Gridcheck access list description', admins=[session.charid])
    try:
        groupInfoWnd.GetGroupInfo = lambda requested: group
        link.handle_access_group_link(url)
        window = groupInfoWnd.GroupInfoWnd.GetIfOpen(windowID=window_id)
        return {'stationID': session.stationid, 'url': url, 'parsed': link.parse_access_group_url(url),
                'windowID': window.windowID, 'title': GetByLabel(window.default_captionLabelPath),
                'content': [child.text for child in window.contentCont.children if hasattr(child, 'text')],
                'dragID': window.GetDragDataForIcon()[0].groupID,
                'dragLabel': window.GetDragDataForIcon()[0].label,
                'empty': GetByLabel('UI/Structures/AccessGroups/NoGroupDescription')}
    finally:
        groupInfoWnd.GetGroupInfo = original
        window = groupInfoWnd.GroupInfoWnd.GetIfOpen(windowID=window_id)
        if window is not None:
            window.CloseByUser()


result = observe()
