from eve.client.script.ui.structure.accessGroups import accessGroupsController as access
from eve.client.script.ui.structure.accessGroups.menuProvider import MenuProvider
from utillib import KeyVal


class Observer(object):
    def __init__(self):
        self.remoteSvc = self
        self.requests = []

    def DeleteMembers(self, groupID, memberIDs):
        self.requests.append([groupID, memberIDs])
        return []

    def RemoveMembers(self, *args):
        pass

    def DisplayWarningIfNeeded(self, **kwargs):
        pass

    def RemoveFromMemberCache(self, *args):
        pass

    def on_groupmembers_removed(self, *args):
        pass


def observe():
    observer = Observer()
    groupID = 123
    node = KeyVal(memberID=session.charid, membershipType=0, entryType=const.typeCharacter, ownerInfo=None)
    menus = [MenuProvider().GetMenuForMember(groupID, [node], 0, observer, corpOwned) for corpOwned in (False, True)]
    labels = [[unicode(entry[0]) for entry in menu if entry is not None] for menu in menus]
    prompts = []
    original = access.prompt_player_fsd_dialog
    try:
        for answer in (access.uiconst.ID_NO, access.uiconst.ID_YES):
            def prompt(name, **kwargs):
                prompts.append(name)
                return answer
            access.prompt_player_fsd_dialog = prompt
            access.AccessGroupsController.RemoveMembers.im_func(observer, groupID, {session.charid})
    finally:
        access.prompt_player_fsd_dialog = original
    return {'stationID': session.stationid, 'characterID': session.charid,
            'personal': labels[0], 'corporation': labels[1],
            'prompts': prompts, 'requests': observer.requests}


result = observe()
