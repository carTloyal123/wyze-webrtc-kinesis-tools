// WebSocket and WebRTC based multi-user chat sample with two-way video
// calling, including use of TURN if applicable or necessary.
//
// This file contains the JavaScript code that implements the client-side
// features for connecting and managing chat and video calls.
//
// To read about how this sample works:  http://bit.ly/webrtc-from-chat
//
// Any copyright is dedicated to the Public Domain.
// http://creativecommons.org/publicdomain/zero/1.0/

"use strict";
// Get our hostname
var signalJsonStr = '';





function log(text) {
  var time = new Date();

  console.log("[" + time.toLocaleTimeString() + "] " + text);
}

const MessageType = {
  SDP_ANSWER: 'SDP_ANSWER',
  SDP_OFFER : 'SDP_OFFER',
  ICE_CANDIDATE : 'ICE_CANDIDATE',
  STATUS_RESPONSE : 'STATUS_RESPONSE'
}

var signalJson = JSON.parse(signalJsonStr)
var kvsClientId = signalJson.ClientId
var signalToken = signalJson.signalToken

// WebSocket chat/signaling channel variables.

var connection = null;
var clientID = 0;

// The media constraints object describes what sort of stream we want
// to request from the local A/V hardware (typically a webcam and
// microphone). Here, we specify only that we want both audio and
// video; however, you can be more specific. It's possible to state
// that you would prefer (or require) specific resolutions of video,
// whether to prefer the user-facing or rear-facing camera (if available),
// and so on.
//
// See also:
// https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamConstraints
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
//

var mediaConstraints = {
  audio: true,            // We want an audio track
  video: true             // ...and we want a video track
};

var myUsername = null;
var targetUsername = null;      // To store username of other peer
var myPeerConnection = null;    // RTCPeerConnection
let receiveChannel = null; // RTCDataChannel for the remote (receiver)


// To work both with and without addTrack() we need to note
// if it's available

var hasAddTrack = false;

// Output logging information to console.



// Output an error message to console.

function log_error(text) {
  var time = new Date();

  console.error("[" + time.toLocaleTimeString() + "] " + text);
}

// Send a JavaScript object by converting it to JSON and sending
// it as a message on the WebSocket connection.

function sendToServer(act, messagePayload, recipientClientId) {
  log("Sending to server: " + act)
  var obj = {"action": act, "messagePayload": serializeJSONObjectAsBase64String(messagePayload), "recipientClientId": recipientClientId}
  var msg = JSON.stringify(obj)
  connection.send(msg);
}

function serializeJSONObjectAsBase64String(obj) {
  return btoa(JSON.stringify(obj))
}

function parseJSONObjectFromBase64String(base64EncodedString) {
  return JSON.parse(atob(base64EncodedString));
}


// Called when the "id" message is received; this message is sent by the
// server to assign this login session a unique ID number; in response,
// this function sends a "username" message to set our username for this
// session.


// Open and configure the connection to the WebSocket server.

function connect() {

  var serverUrl = signalJson.signalingUrl
  connection = new WebSocket(serverUrl);

  connection.onopen = function(evt) {
    log("Opened Websocket!")
    console.dir(connection)
  };

  connection.onerror = function(evt) {
    console.dir(evt);
  }

  connection.onmessage = function(evt) {
    if (evt.data) {
      log("WE HAVE DATA")
      log(evt.data)
    }
    let parsedEventData;
    let parsedMessagePayload;
    try {
        parsedEventData = JSON.parse(evt.data);
        parsedMessagePayload = parseJSONObjectFromBase64String(parsedEventData.messagePayload);
    } catch (e) {
        // For forwards compatibility we ignore messages that are not able to be parsed.
        // TODO: Consider how to make it easier for users to be aware of dropped messages.
        return;
    }
    const { messageType, senderClientId } = parsedEventData;

    switch (messageType) {
        case MessageType.SDP_OFFER:
          log("Got sdp offer!")
          handleVideoOfferMsg(evt)
          return;
        case MessageType.SDP_ANSWER:
          // handle sdp answer
          log("Got sdp answer!")
          handleVideoAnswerMsg(evt)
          return;
        case MessageType.ICE_CANDIDATE:
          handleNewICECandidateMsg(evt)
          return;
        case MessageType.STATUS_RESPONSE:
          log("Status response!" + parsedEventData["statusResponse"])
        default:
          log("Unknown message type!--------------------------------------")
    }
  };
}

// Create the RTCPeerConnection which knows how to talk to our
// selected STUN/TURN server and then uses getUserMedia() to find
// our camera and microphone and add that stream to the connection for
// use in our video call. Then we configure event handlers to get
// needed notifications on the call.

function createPeerConnection() {
  log("Setting up a connection...");

  // Create an RTCPeerConnection which knows to use our chosen
  // STUN server.

  myPeerConnection = new RTCPeerConnection({
    iceServers: signalJson["servers"] });

  // Do we have addTrack()? If not, we will use streams instead.

  hasAddTrack = (myPeerConnection.addTrack !== undefined);
  // Set up event handlers for the ICE negotiation process.

  myPeerConnection.onicecandidate = handleICECandidateEvent;
  myPeerConnection.onremovestream = handleRemoveStreamEvent;
  myPeerConnection.oniceconnectionstatechange = handleICEConnectionStateChangeEvent;
  myPeerConnection.onicegatheringstatechange = handleICEGatheringStateChangeEvent;
  myPeerConnection.onsignalingstatechange = handleSignalingStateChangeEvent;
  myPeerConnection.onnegotiationneeded = handleNegotiationNeededEvent;
  myPeerConnection.ondatachannel = receiveChannelCallback;

  // Because the deprecation of addStream() and the addstream event is recent,
  // we need to use those if addTrack() and track aren't available.
  myPeerConnection.ontrack = handleTrackEvent;
  myPeerConnection.onaddstream = handleAddStreamEvent;
  log("Created a connection...");
}

// Data channel callback
function receiveChannelCallback(event) {
  log("Channel event recieved!")
  receiveChannel = event.channel;
  receiveChannel.onmessage = handleReceiveMessage;
  receiveChannel.onopen = handleReceiveChannelStatusChange;
  receiveChannel.onclose = handleReceiveChannelStatusChange;
}

function handleReceiveMessage(event) {
  log("Data message: " + event.data)
}

function handleReceiveChannelStatusChange(event) {
  log(
    `Receive channel's status has changed to ${receiveChannel.readyState}`
  );
}

// Called by the WebRTC layer to let us know when it's time to
// begin (or restart) ICE negotiation. Starts by creating a WebRTC
// offer, then sets it as the description of our local media
// (which configures our local media stream), then sends the
// description to the callee as an offer. This is a proposed media
// format, codec, resolution, etc.

function handleNegotiationNeededEvent() {
  log("*** Negotiation needed");

  log("---> Creating offer");
  myPeerConnection.createOffer().then(function(offer) {
    log("---> Creating new description object to send to remote peer");
    return myPeerConnection.setLocalDescription(offer);
  })
  .then(function() {
    log("---> Sending offer to remote peer");
    sendToServer(MessageType.SDP_OFFER, myPeerConnection.localDescription.toJSON(), kvsClientId);
  })
  .catch(reportError);
}

// Called by the WebRTC layer when events occur on the media tracks
// on our WebRTC call. This includes when streams are added to and
// removed from the call.
//
// track events include the following fields:
//
// RTCRtpReceiver       receiver
// MediaStreamTrack     track
// MediaStream[]        streams
// RTCRtpTransceiver    transceiver

function handleTrackEvent(event) {
  log("*** Track event");
  document.getElementById("received_video").srcObject = event.streams[0];
  document.getElementById("hangup-button").disabled = false;
}

// Called by the WebRTC layer when a stream starts arriving from the
// remote peer. We use this to update our user interface, in this
// example.

function handleAddStreamEvent(event) {
  log("*** Stream added");
  document.getElementById("received_video").srcObject = event.stream;
  document.getElementById("hangup-button").disabled = false;
}

// An event handler which is called when the remote end of the connection
// removes its stream. We consider this the same as hanging up the call.
// It could just as well be treated as a "mute".
//
// Note that currently, the spec is hazy on exactly when this and other
// "connection failure" scenarios should occur, so sometimes they simply
// don't happen.

function handleRemoveStreamEvent(event) {
  log("*** Stream removed");
  closeVideoCall();
}

// Handles |icecandidate| events by forwarding the specified
// ICE candidate (created by our local ICE agent) to the other
// peer through the signaling server.

function handleICECandidateEvent(event) {
  log("Handling ICE candidate! ")
  console.dir(event)
  if (event.candidate) {
    sendToServer(MessageType.ICE_CANDIDATE, event.candidate.toJSON(), kvsClientId);
  }
}

// Handle |iceconnectionstatechange| events. This will detect
// when the ICE connection is closed, failed, or disconnected.
//
// This is called when the state of the ICE agent changes.

function handleICEConnectionStateChangeEvent(event) {
  log("*** ICE connection state changed to " + myPeerConnection.iceConnectionState);

  switch(myPeerConnection.iceConnectionState) {
    case "closed":
    case "failed":
    case "disconnected":
      closeVideoCall();
      break;
  }
}

// Set up a |signalingstatechange| event handler. This will detect when
// the signaling connection is closed.
//
// NOTE: This will actually move to the new RTCPeerConnectionState enum
// returned in the property RTCPeerConnection.connectionState when
// browsers catch up with the latest version of the specification!

function handleSignalingStateChangeEvent(event) {
  log("*** WebRTC signaling state changed to: " + myPeerConnection.signalingState);
  switch(myPeerConnection.signalingState) {
    case "closed":
      closeVideoCall();
      break;
  }
}

// Handle the |icegatheringstatechange| event. This lets us know what the
// ICE engine is currently working on: "new" means no networking has happened
// yet, "gathering" means the ICE engine is currently gathering candidates,
// and "complete" means gathering is complete. Note that the engine can
// alternate between "gathering" and "complete" repeatedly as needs and
// circumstances change.
//
// We don't need to do anything when this happens, but we log it to the
// console so you can see what's going on when playing with the sample.

function handleICEGatheringStateChangeEvent(event) {
  log("*** ICE gathering state changed to: " + myPeerConnection.iceGatheringState);
}

// Given a message containing a list of usernames, this function
// populates the user list box with those names, making each item
// clickable to allow starting a video call.

function handleUserlistMsg(msg) {
  var i;

  var listElem = document.getElementById("userlistbox");

  // Remove all current list members. We could do this smarter,
  // by adding and updating users instead of rebuilding from
  // scratch but this will do for this sample.

  while (listElem.firstChild) {
    listElem.removeChild(listElem.firstChild);
  }

  // Add member names from the received list

  for (i=0; i < msg.users.length; i++) {
    var item = document.createElement("li");
    item.appendChild(document.createTextNode(msg.users[i]));
    item.addEventListener("click", invite, false);

    listElem.appendChild(item);
  }
}

// Close the RTCPeerConnection and reset variables so that the user can
// make or receive another call if they wish. This is called both
// when the user hangs up, the other user hangs up, or if a connection
// failure is detected.

function closeVideoCall() {
  var remoteVideo = document.getElementById("received_video");
  var localVideo = document.getElementById("local_video");

  log("Closing the call");
  connection.close()

  // Close the RTCPeerConnection

  if (myPeerConnection) {
    log("--> Closing the peer connection");

    // Disconnect all our event listeners; we don't want stray events
    // to interfere with the hangup while it's ongoing.

    myPeerConnection.onaddstream = null;  // For older implementations
    myPeerConnection.ontrack = null;      // For newer ones
    myPeerConnection.onremovestream = null;
    myPeerConnection.onnicecandidate = null;
    myPeerConnection.oniceconnectionstatechange = null;
    myPeerConnection.onsignalingstatechange = null;
    myPeerConnection.onicegatheringstatechange = null;
    myPeerConnection.onnotificationneeded = null;

    // Stop the videos

    if (remoteVideo.srcObject) {
      remoteVideo.srcObject.getTracks().forEach(track => track.stop());
    }

    if (localVideo.srcObject) {
      localVideo.srcObject.getTracks().forEach(track => track.stop());
    }

    remoteVideo.src = null;
    localVideo.src = null;

    // Close the peer connection

    myPeerConnection.close();
    myPeerConnection = null;
  }

  // Disable the hangup button

  document.getElementById("hangup-button").disabled = true;

  targetUsername = null;
}

// Handle the "hang-up" message, which is sent if the other peer
// has hung up the call or otherwise disconnected.

function handleHangUpMsg(msg) {
  log("*** Received hang up notification from other peer");

  closeVideoCall();
}

// Hang up the call by closing our end of the connection, then
// sending a "hang-up" message to the other peer (keep in mind that
// the signaling is done on a different connection). This notifies
// the other peer that the connection should be terminated and the UI
// returned to the "no call in progress" state.

function hangUpCall() {
  closeVideoCall();
  sendToServer({
    name: myUsername,
    target: targetUsername,
    type: "hang-up"
  });
}

// Handle a click on an item in the user list by inviting the clicked
// user to video chat. Note that we don't actually send a message to
// the callee here -- calling RTCPeerConnection.addStream() issues
// a |notificationneeded| event, so we'll let our handler for that
// make the offer.

function invite(evt) {
  log("Starting to prepare an invitation");
  if (myPeerConnection) {
    alert("You can't start a call because you already have one open!");
  } else {
    log("Setting up connection to invite user: " + "Amazon!");
    createPeerConnection();

    // Now configure and create the local stream, attach it to the
    // "preview" box (id "local_video"), and add it to the
    // RTCPeerConnection.

    log("Requesting webcam access...");

    navigator.mediaDevices.getUserMedia(mediaConstraints)
    .then(function(localStream) {
      log("-- Local video stream obtained");
      document.getElementById("local_video").srcObject = localStream;

      if (hasAddTrack) {
        log("-- Adding tracks to the RTCPeerConnection");
        localStream.getTracks().forEach(track => myPeerConnection.addTrack(track, localStream));
      } else {
        log("-- Adding stream to the RTCPeerConnection");
        myPeerConnection.addStream(localStream);
      }
    })
    .catch(handleGetUserMediaError);
  }
}

// Accept an offer to video chat. We configure our local settings,
// create our RTCPeerConnection, get and attach our local camera
// stream, then create and send an answer to the caller.

function handleVideoOfferMsg(evt) {
  var localStream = null;

  let parsedEventData;
  let parsedMessagePayload;
  try {
      parsedEventData = JSON.parse(evt.data);
      parsedMessagePayload = parseJSONObjectFromBase64String(parsedEventData.messagePayload);
  } catch (e) {
      // For forwards compatibility we ignore messages that are not able to be parsed.
      // TODO: Consider how to make it easier for users to be aware of dropped messages.
      return;
  }

  targetUsername = "Amazon";

  // Call createPeerConnection() to create the RTCPeerConnection.

  log("Starting to accept invitation from " + targetUsername);
  createPeerConnection();

  // We need to set the remote description to the received SDP offer
  // so that our local WebRTC layer knows how to talk to the caller.

  var desc = new RTCSessionDescription(parsedMessagePayload);

  myPeerConnection.setRemoteDescription(desc).then(function () {
    log("Setting up the local media stream...");
    return navigator.mediaDevices.getUserMedia(mediaConstraints);
  })
  .then(function(stream) {
    log("-- Local video stream obtained");
    localStream = stream;
    document.getElementById("local_video").srcObject = localStream;

    if (hasAddTrack) {
      log("-- Adding tracks to the RTCPeerConnection");
      localStream.getTracks().forEach(track =>
            myPeerConnection.addTrack(track, localStream)
      );
    } else {
      log("-- Adding stream to the RTCPeerConnection");
      myPeerConnection.addStream(localStream);
    }
  })
  .then(function() {
    log("------> Creating answer");
    // Now that we've successfully set the remote description, we need to
    // start our stream up locally then create an SDP answer. This SDP
    // data describes the local end of our call, including the codec
    // information, options agreed upon, and so forth.
    return myPeerConnection.createAnswer();
  })
  .then(function(answer) {
    log("------> Setting local description after creating answer");
    // We now have our answer, so establish that as the local description.
    // This actually configures our end of the call to match the settings
    // specified in the SDP.
    return myPeerConnection.setLocalDescription(answer);
  })
  .then(function() {

    // We've configured our end of the call now. Time to send our
    // answer back to the caller so they know that we want to talk
    // and how to talk to us.

    log("Sending answer packet back to other peer");
    sendToServer()
  })
  .catch(handleGetUserMediaError);
}

// Responds to the "video-answer" message sent to the caller
// once the callee has decided to accept our request to talk.

function handleVideoAnswerMsg(evt) {
  log("Call recipient has accepted our call");

  // Configure the remote description, which is the SDP payload
  // in our "video-answer" message.

  let parsedEventData;
  let parsedMessagePayload;
  try {
      parsedEventData = JSON.parse(evt.data);
      parsedMessagePayload = parseJSONObjectFromBase64String(parsedEventData.messagePayload);
  } catch (e) {
      // For forwards compatibility we ignore messages that are not able to be parsed.
      // TODO: Consider how to make it easier for users to be aware of dropped messages.
      return;
  }

  var desc = new RTCSessionDescription(parsedMessagePayload);
  myPeerConnection.setRemoteDescription(desc).catch(reportError);
}

// A new ICE candidate has been received from the other peer. Call
// RTCPeerConnection.addIceCandidate() to send it along to the
// local ICE framework.

function handleNewICECandidateMsg(evt) {
  // decode candidate info first
  let parsedEventData;
  let parsedMessagePayload;
  try {
      parsedEventData = JSON.parse(evt.data);
      parsedMessagePayload = parseJSONObjectFromBase64String(parsedEventData.messagePayload);
  } catch (e) {
      // For forwards compatibility we ignore messages that are not able to be parsed.
      // TODO: Consider how to make it easier for users to be aware of dropped messages.
      log("Can not parse Ice candidate :/")
      return;
  }

  var candidate = new RTCIceCandidate(parsedMessagePayload);

  log("Adding received ICE candidate: " + JSON.stringify(candidate));
  myPeerConnection.addIceCandidate(candidate)
    .catch(reportError);
}

// Handle errors which occur when trying to access the local media
// hardware; that is, exceptions thrown by getUserMedia(). The two most
// likely scenarios are that the user has no camera and/or microphone
// or that they declined to share their equipment when prompted. If
// they simply opted not to share their media, that's not really an
// error, so we won't present a message in that situation.

function handleGetUserMediaError(e) {
  log(e);
  switch(e.name) {
    case "NotFoundError":
      alert("Unable to open your call because no camera and/or microphone" +
            "were found.");
      break;
    case "SecurityError":
    case "PermissionDeniedError":
      // Do nothing; this is the same as the user canceling the call.
      break;
    default:
      alert("Error opening your camera and/or microphone: " + e.message);
      break;
  }

  // Make sure we shut down our end of the RTCPeerConnection so we're
  // ready to try again.

  closeVideoCall();
}

// Handles reporting errors. Currently, we just dump stuff to console but
// in a real-world application, an appropriate (and user-friendly)
// error message should be displayed.

function reportError(errMessage) {
  log_error("Error " + errMessage.name + ": " + errMessage.message);
}
