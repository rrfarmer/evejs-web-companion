from types import FunctionType

from carbonui import uiconst
from eve.client.script.ui.services.menuSvcExtras import menuFunctions
from localization import GetByLabel
from menucheckers.itemCheckers import ItemChecker
from utillib import KeyVal


def observe():
    types = [dict(typeID=type_id, offered=ItemChecker(KeyVal(typeID=type_id)).OfferActivateCharacterReSculptToken())
             for type_id in (34132, 89956, 34)]
    calls = []
    selected = [uiconst.ID_NO]

    def prompt(key, values, buttons):
        calls.append(dict(dialog=key, values=values, yesNo=buttons == uiconst.YESNO))
        return selected[0]

    def remote(service):
        return KeyVal(ActivateCharacterReSculpt=lambda item_id: calls.append(dict(service=service, itemID=item_id)))

    original = menuFunctions.ActivateCharacterReSculpt
    call = FunctionType(original.func_code, dict(original.func_globals, prompt_player_fsd_dialog=prompt,
                                                sm=KeyVal(RemoteSvc=remote)))
    call(880000001)
    no = calls[:]
    del calls[:]
    selected[0] = uiconst.ID_YES
    call(880000002)
    return dict(station=session.stationid, types=types, no=no, yes=calls,
                label=GetByLabel('UI/Commands/ActivateCharacterReSculptToken'))


result = observe()
