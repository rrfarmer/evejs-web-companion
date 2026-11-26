from carbonui import const as uiconst
from eve.client.script.ui.shared.pointerTool import favorites as fav, pointerToolUtil
from eve.client.script.ui.util import utilWindows
from localization import GetByLabel
from utillib import KeyVal


def observe():
    key = fav.FAVORITES_SETTING_CONFIG_NAME
    saved = settings.user.ui.Get(key, None)
    original_popup = utilWindows.NamePopup
    original_prompt = fav.prompt_player_fsd_dialog
    popups = []
    prompts = []
    names = iter(('Trade tools', 'Other tools'))
    answers = iter((uiconst.ID_NO, uiconst.ID_YES))

    def name_popup(title, text, maxLength=None):
        popups.append([title, text, maxLength])
        return next(names)

    def confirmation(name, arguments, buttons):
        prompts.append([name, arguments['groupName']])
        return next(answers)

    def contents():
        return [[group.groupID, group.groupName, list(group.uiElementNames)]
                for group in [fav.GetFavoriteRootGroup()] + fav.GetFavoriteGroups()]

    def filtered_favorites(query):
        groups = pointerToolUtil._GetFavoriteGroup(query)
        if not groups:
            return []
        rows = pointerToolUtil._GetFavoriteSubGroups(groups[0])
        return [[row.label, [child.label for child in pointerToolUtil._GetFavoriteSubGroups(row)]
                 if row.get('groupKeyVal') else []] for row in rows]

    try:
        settings.user.ui.Set(key, fav.GetFavoriteKeyVal(groupID=0))
        utilWindows.NamePopup = name_popup
        fav.prompt_player_fsd_dialog = confirmation
        fav.AddFavoriteGroup()
        fav.AddFavoriteGroup()
        trade, other = fav.GetFavoriteGroups()
        catalog = sm.GetService('helpPointer').GetAllPointersByElementName()
        wallet = KeyVal(pointerObjects=[catalog['neocom.wallet']])
        fitting = KeyVal(pointerObjects=[catalog['neocom.fitting']])
        fav.AddToFavoriteGroup(0, wallet)
        fav.AddToFavoriteGroup(trade.groupID, wallet)
        fav.AddToFavoriteGroup(trade.groupID, wallet)
        fav.AddToFavoriteGroup(trade.groupID, fitting)
        fav.AddElementsToGroup(trade.groupID, [fitting], idx=0)
        fav.OnDropDataInFavorite(('uiPointerFavorites', other.groupID), [fitting])
        after_add = contents()
        filters = {query: filtered_favorites(query) for query in ('trade tools', 'wallet', 'no such pointer')}
        fav.RemoveElementFromGroup(other.groupID, [fitting])
        after_remove = contents()
        fav.RemoveSubGroup(trade.groupID)
        after_no = contents()
        fav.RemoveSubGroup(trade.groupID)
        return dict(station=session.stationid, popups=popups, prompts=prompts, afterAdd=after_add,
                    filters=filters, afterRemove=after_remove, afterNo=after_no, afterYes=contents(),
                    labels=[GetByLabel('UI/HelpPointers/Wnd/' + suffix)
                            for suffix in ('AddGroup', 'DeleteGroup', 'AddToFavoriteRoot',
                                           'AddToFavoriteSubGroup', 'RemoveFromGroup')])
    finally:
        utilWindows.NamePopup = original_popup
        fav.prompt_player_fsd_dialog = original_prompt
        settings.user.ui.Set(key, saved)


result = observe()
