"""Observe the installed medal fee callbacks with projected server replies."""
import types
from carbonui import uiconst
from eve.common.lib import appConst
from eve.client.script.ui.services.medals import Medals
from eveexceptions import UserError
from utillib import KeyVal

cost = 10000000
medal_id = 1
recipients = [session.charid, session.charid + 1]
reason = 'Perimeter Services'
source = Medals.GiveMedalToCharacters
function = getattr(source, 'im_func', source)
try:
    confirmation_keys = sorted(key for key in cfg.messages.keys() if key.startswith('ConfirmGivingMedal'))
except (AttributeError, TypeError):
    confirmation_keys = []
confirmation_key = confirmation_keys[0] if confirmation_keys else 'ConfirmGivingMedal'


class AwardServer:
    def __init__(self, refusal):
        self.refusal = refusal
        self.calls = []

    def RemoteSvc(self, name):
        if name != 'corporationSvc':
            raise RuntimeError('Unexpected remote service')
        return self

    def GiveMedalToCharacters(self, *args):
        self.calls.append(args)
        if len(self.calls) == 1:
            values = {'amount': cost, 'balance': 0} if self.refusal == 'NotEnoughMoney' else {'cost': cost}
            raise UserError(self.refusal, values)


def observe(refusal, answer):
    prompts = []

    def prompt(key, values, buttons=None, suppress=None):
        try:
            message = cfg.GetMessage(key, values, onNotFound='raise')
            rendered = {'title': unicode(message.title or ''), 'text': unicode(message.text or ''),
                        'type': message.type}
        except Exception:
            rendered = None
        prompts.append({'key': key, 'values': values, 'yesNo': buttons == uiconst.YESNO,
                        'suppressYes': suppress == uiconst.ID_YES, 'rendered': rendered})
        return answer

    server = AwardServer(refusal)
    scope = dict(function.func_globals, sm=server, session=KeyVal(corprole=appConst.corpRolePersonnelManager),
                 prompt_player_fsd_dialog=prompt)
    callback = types.FunctionType(function.func_code, scope, function.func_name, function.func_defaults)
    callback(None, medal_id, recipients, reason)
    return {'calls': server.calls, 'prompts': prompts}


result = {
    'station': session.stationid,
    'pilot': session.charid,
    'costInput': cost,
    'confirmationKeys': confirmation_keys,
    'declined': observe(confirmation_key, uiconst.ID_NO),
    'confirmed': observe(confirmation_key, uiconst.ID_YES),
    'insufficient': observe('NotEnoughMoney', uiconst.ID_OK),
}
