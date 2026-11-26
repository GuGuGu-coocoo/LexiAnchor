#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

static id monitor;
static napi_ref listener;

static void StopMonitor(napi_env env) {
  if (monitor) [NSEvent removeMonitor:monitor];
  monitor = nil;
  if (listener) napi_delete_reference(env, listener);
  listener = nullptr;
}

static napi_value Start(napi_env env, napi_callback_info info) {
  napi_value args[2];
  size_t argc = 2, bytes = 0;
  void *handle = nullptr;
  napi_valuetype callbackType;
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2 || napi_get_buffer_info(env, args[0], &handle, &bytes) != napi_ok ||
      bytes != sizeof(void *) || napi_typeof(env, args[1], &callbackType) != napi_ok ||
      callbackType != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected an Electron NSView handle and a listener");
    return nullptr;
  }
  StopMonitor(env);
  void *viewPointer;
  std::memcpy(&viewPointer, handle, sizeof(viewPointer));
  __weak NSView *view = (__bridge NSView *)viewPointer;
  napi_create_reference(env, args[1], 1, &listener);
  monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskScrollWheel
    handler:^NSEvent *(NSEvent *event) {
      NSView *currentView = view;
      NSWindow *window = currentView.window;
      if (!window || !event.hasPreciseScrollingDeltas ||
          (event.phase == NSEventPhaseNone && event.momentumPhase == NSEventPhaseNone)) {
        return event;
      }

      NSPoint location = event.locationInWindow;
      if (event.window != window) {
        // A windowless scroll event reports a screen point. Do not attribute
        // it to this view when another window would receive input at that point.
        if (event.window || window != NSApp.keyWindow ||
            [NSWindow windowNumberAtPoint:location belowWindowWithWindowNumber:0] != window.windowNumber) {
          return event;
        }
        location = [window convertPointFromScreen:location];
      }
      NSPoint point = [currentView convertPoint:location fromView:nil];
      NSRect bounds = currentView.bounds;
      const double x = point.x - NSMinX(bounds);
      const double y = currentView.isFlipped ? point.y - NSMinY(bounds) : NSMaxY(bounds) - point.y;
      const bool modified =
        (event.modifierFlags & (NSEventModifierFlagControl | NSEventModifierFlagCommand)) != 0;
      napi_handle_scope scope;
      if (napi_open_handle_scope(env, &scope) != napi_ok) return event;
      napi_value callback, receiver, args[7], result;
      napi_get_reference_value(env, listener, &callback);
      napi_get_undefined(env, &receiver);
      napi_create_uint32(env, event.phase, &args[0]);
      napi_create_uint32(env, event.momentumPhase, &args[1]);
      napi_create_double(env, -event.scrollingDeltaX, &args[2]);
      napi_create_double(env, -event.scrollingDeltaY, &args[3]);
      napi_create_double(env, x, &args[4]);
      napi_create_double(env, y, &args[5]);
      napi_get_boolean(env, modified, &args[6]);
      bool consumed = false;
      if (napi_call_function(env, receiver, callback, 7, args, &result) == napi_ok)
        napi_get_value_bool(env, result, &consumed);
      napi_close_handle_scope(env, scope);
      return consumed ? nil : event;
    }];
  return nullptr;
}

static napi_value Stop(napi_env env, napi_callback_info) {
  StopMonitor(env);
  return nullptr;
}

NAPI_MODULE_INIT() {
  napi_property_descriptor methods[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, methods);
  return exports;
}
