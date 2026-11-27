from raffles.client.create.controller import CreatePageController, CreationStatus
from raffles.client.create.result import CreateResult
from raffles.client.localization import Text, get_error_message
from raffles.common.errors import CreateErrorReason

events = []
class Signal(object):
    def __call__(self, *args):
        events.append(args)

class Navigation(object):
    def open_details_page(self, raffle_id):
        events.append(('view', raffle_id))

controller = CreatePageController.__new__(CreatePageController)
controller.raffle_id = 91
controller.status = CreationStatus.creating
controller.on_creation_success = Signal()
controller.on_creation_failure = Signal()
controller.on_item_changed = Signal()
controller._on_raffle_created(type('Offer', (object,), {'raffle_id': 92})())
ignored = controller.status == CreationStatus.creating and not events
controller.OnRaffleCreationFailedServer(92, CreateErrorReason.token_amount)
ignored_failure = controller.status == CreationStatus.creating and not events
controller._on_raffle_created(type('Offer', (object,), {'raffle_id': 91})())
success = controller.status == CreationStatus.success and events[-1][0].raffle_id == 91
controller.OnRaffleCreationFailedServer(91, CreateErrorReason.token_amount)
failure = controller.status == CreationStatus.failure and events[-1][0] == CreateErrorReason.token_amount
view = CreateResult.__new__(CreateResult)
view._controller = controller
view._navigation = Navigation()
controller._item = None
view._handle_view_raffle()
opened = events[-1] == ('view', 91)
view._handle_confirm_error()
result = dict(station=session.stationid, ignored=ignored, ignoredFailure=ignored_failure, success=success, failure=failure,
              opened=opened, reset=controller.status == CreationStatus.none and controller.raffle_id is None,
              labels=[Text.create_button(), Text.confirm_purchase(), Text.creating(), Text.create_success_title(),
                      Text.create_success_message(), Text.create_another(), Text.view_raffle(),
                      Text.create_failed_title(), Text.confirm_creation_failed(), Text.clear_button()],
              refusal=get_error_message(CreateErrorReason.token_amount))
