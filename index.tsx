import React, { useState, useEffect, useRef } from 'react';
// Fix: Explicitly import JSX type from 'react' to resolve "Cannot find namespace 'JSX'" error.
import type { JSX } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI, Chat, GenerateContentResponse } from "@google/genai";

// Utility functions for base64 encoding/decoding, kept for consistency but not actively used for current text tasks.
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const apiKey = process.env.API_KEY;

type UserMode = 'none' | 'passenger' | 'driver';
type DriverStatus = 'offline' | 'online' | 'request_pending' | 'on_ride' | 'ride_completed';
type RideStatus = 'searching' | 'found' | 'tracking' | 'completed' | 'canceled';
type VehicleType = 'Car' | 'Bike';
type PaymentMethod = 'Cash' | 'Wallet';

interface ChatMessage {
  sender: 'user' | 'ai';
  text: string | JSX.Element; // Allow JSX.Element for LoadingSpinner
}

interface RideOffer {
  driverName: string;
  driverRating: number;
  vehicleType: VehicleType;
  licensePlate: string;
  etaMinutes: number;
  estimatedFare: number;
  pickup: string;
  destination: string;
  passengerName?: string; // For driver requests
  passengerRating?: number; // For driver requests
}

const LoadingSpinner: React.FC<{ message?: string }> = ({ message = 'Loading...' }) => (
  <div className="loading-indicator" aria-live="assertive">
    <div className="spinner" role="status"></div>
    <span>{message}</span>
  </div>
);

const MockMap: React.FC<{ pickup?: string; destination?: string; status?: string }> = ({ pickup, destination, status }) => {
  let mapText = "Map View: Waiting for route...";
  if (pickup && destination && status === 'tracking') {
    mapText = `Tracking ride from ${pickup} to ${destination}`;
  } else if (pickup && destination) {
    mapText = `Route from ${pickup} to ${destination}`;
  }
  return (
    <div className="mock-map" aria-label={mapText}>
      {mapText}
      {status === 'tracking' && <span className="spinner" style={{marginLeft: '10px'}}></span>}
    </div>
  );
};


const App: React.FC = () => {
  const [userMode, setUserMode] = useState<UserMode>('none');
  const [currentLocation, setCurrentLocation] = useState<string>('');
  const [pickupLocation, setPickupLocation] = useState<string>('');
  const [destination, setDestination] = useState<string>('');
  const [vehicleType, setVehicleType] = useState<VehicleType>('Car');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cash');

  const [driverStatus, setDriverStatus] = useState<DriverStatus>('offline');
  const [currentRideOffer, setCurrentRideOffer] = useState<RideOffer | null>(null);
  const [passengerRideStatus, setPassengerRideStatus] = useState<RideStatus | null>(null);

  const [apiResponse, setApiResponse] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);

  // Chat Assistant States
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState<string>('');
  const chatRef = useRef<Chat | null>(null);
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const driverRequestIntervalRef = useRef<number | null>(null);
  const rideTrackingIntervalRef = useRef<number | null>(null);


  // Scroll to bottom of chat messages
  useEffect(() => {
    if (chatMessagesEndRef.current) {
      chatMessagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatOpen]);


  // Offline/Online status handling
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Geolocation effect
  useEffect(() => {
    if (navigator.geolocation && isOnline) {
      setLoading(true);
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          // Mock reverse geocoding
          const locationNames = [
            "Dhaka University", "Mirpur 10", "Gulshan 1", "Bashundhara R/A",
            "Farmgate", "Motijheel", "Dhanmondi 32", "Uttara Sector 11"
          ];
          const randomLocation = locationNames[Math.floor(Math.random() * locationNames.length)];
          const locationString = `Approx. ${randomLocation} (Lat: ${latitude.toFixed(4)}, Lon: ${longitude.toFixed(4)})`;
          setCurrentLocation(locationString);
          setPickupLocation(locationString); // Pre-fill pickup for passenger
          setError('');
          setLoading(false);
        },
        (geoError) => {
          console.error("Geolocation error:", geoError);
          setError(`Location access denied or failed. Please enable location services or enter manually. (${geoError.message})`);
          setLoading(false);
          setCurrentLocation("Manual Entry Needed");
          setPickupLocation("");
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    } else if (!isOnline) {
      setError("You are offline. Geolocation requires internet connection.");
      setCurrentLocation("Manual Entry Needed (Offline)");
      setPickupLocation("");
      setLoading(false);
    } else {
      setError("Geolocation not supported. Please enter locations manually.");
      setCurrentLocation("Manual Entry Needed");
      setPickupLocation("");
      setLoading(false);
    }
  }, [isOnline]);

  // Driver mode logic: simulating ride requests and tracking
  useEffect(() => {
    const simulateDriverActivity = async () => {
      if (driverStatus === 'online' && isOnline && !loading && !currentRideOffer) {
        setLoading(true);
        setError('');
        try {
          const ai = new GoogleGenAI({ apiKey: apiKey });
          const locations = ["Dhaka University", "Mirpur 10", "Gulshan 1", "Bashundhara R/A", "Farmgate", "Motijheel", "Dhanmondi 32", "Uttara Sector 11"];
          const randomPickup = locations[Math.floor(Math.random() * locations.length)];
          let randomDestination = locations[Math.floor(Math.random() * locations.length)];
          while (randomDestination === randomPickup) { // Ensure different pickup and destination
            randomDestination = locations[Math.floor(Math.random() * locations.length)];
          }

          const prompt = `Simulate a ride request for a driver. Provide a passenger name (e.g., 'Ahmed'), rating (e.g., 4.7), a pickup location (e.g., '${randomPickup}'), a destination (e.g., '${randomDestination}'), and an estimated fare between 150 BDT and 500 BDT. Format as JSON: {"passengerName": "...", "passengerRating": "...", "pickup": "...", "destination": "...", "fare": "..."}`;

          const response: GenerateContentResponse = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: 'OBJECT',
                properties: {
                  passengerName: { type: 'STRING' },
                  passengerRating: { type: 'NUMBER' },
                  pickup: { type: 'STRING' },
                  destination: { type: 'STRING' },
                  fare: { type: 'NUMBER' },
                },
                required: ["passengerName", "passengerRating", "pickup", "destination", "fare"],
              },
            },
          });
          const text = response.text?.trim();

          if (text) {
            try {
              const requestData = JSON.parse(text);
              setCurrentRideOffer({ ...requestData, estimatedFare: requestData.fare }); // map fare to estimatedFare
              setDriverStatus('request_pending');
              setApiResponse(`নতুন রাইড রিকোয়েস্ট! ${requestData.passengerName} (রেটিং: ${requestData.passengerRating}⭐) ${requestData.pickup} থেকে ${requestData.destination} পর্যন্ত। আনুমানিক ভাড়া: ৳${requestData.fare.toFixed(2)}।`);
            } catch (jsonError) {
              console.error("Failed to parse AI response JSON:", jsonError, text);
              setApiResponse("রাইড রিকোয়েস্ট পাওয়া গেছে, কিন্তু বিস্তারিত তথ্য পার্স করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।");
            }
          } else {
            setApiResponse("কোনো রাইড রিকোয়েস্ট পাওয়া যায়নি।");
          }
        } catch (apiError: any) {
          console.error("Gemini API error (driver request):", apiError);
          setError(`রাইড রিকোয়েস্ট আনতে ব্যর্থ: ${apiError.message || 'অজানা ত্রুটি'}`);
        } finally {
          setLoading(false);
        }
      }
    };

    if (driverStatus === 'online' && !driverRequestIntervalRef.current) {
      driverRequestIntervalRef.current = window.setInterval(simulateDriverActivity, 10000); // Simulate request every 10 seconds
    } else if (driverStatus !== 'online' && driverRequestIntervalRef.current) {
      clearInterval(driverRequestIntervalRef.current);
      driverRequestIntervalRef.current = null;
    }

    return () => {
      if (driverRequestIntervalRef.current) {
        clearInterval(driverRequestIntervalRef.current);
      }
    };
  }, [driverStatus, isOnline, loading, currentRideOffer]); // Added currentRideOffer to dependencies

  // Passenger ride tracking simulation
  useEffect(() => {
    if (passengerRideStatus === 'tracking') {
      let eta = currentRideOffer?.etaMinutes || 5;
      rideTrackingIntervalRef.current = window.setInterval(() => {
        if (eta > 0) {
          eta--;
          setApiResponse(`ড্রাইভার ${eta} মিনিট দূরে আছে। তারা আপনাকে নিতে আসছে।`);
        } else {
          clearInterval(rideTrackingIntervalRef.current!);
          setApiResponse("ড্রাইভার এসে গেছে! আপনার রাইড নিশ্চিত করুন।");
          setPassengerRideStatus('completed'); // Or 'at_pickup' then 'on_ride'
        }
      }, 60000); // Update every minute
    } else if (rideTrackingIntervalRef.current) {
      clearInterval(rideTrackingIntervalRef.current);
      rideTrackingIntervalRef.current = null;
    }
    return () => {
      if (rideTrackingIntervalRef.current) {
        clearInterval(rideTrackingIntervalRef.current);
      }
    };
  }, [passengerRideStatus, currentRideOffer]);


  const handleFindRide = async () => {
    if (!pickupLocation || !destination) {
      setError("অনুগ্রহ করে পিকআপ এবং গন্তব্য উভয় স্থানই প্রবেশ করুন।");
      return;
    }
    if (!isOnline) {
      setError("আপনি অফলাইন। রাইড খুঁজে পাওয়া সম্ভব নয়।");
      return;
    }

    setLoading(true);
    setApiResponse('');
    setError('');
    setCurrentRideOffer(null);
    setPassengerRideStatus('searching');

    try {
      const ai = new GoogleGenAI({ apiKey: apiKey });
      const prompt = `Find a ${vehicleType} ride for a passenger from "${pickupLocation}" to "${destination}". Generate a mock driver's name, their rating out of 5, vehicle type, a random license plate (e.g., 'ABC-123'), an estimated arrival time (ETA) in minutes (e.g., 3-10 minutes), and an approximate fare in BDT (between ৳100 and ৳600).
      Format the response as JSON: {"driverName": "...", "driverRating": "...", "vehicleType": "...", "licensePlate": "...", "etaMinutes": "...", "estimatedFare": "..."}
      If no drivers are available, respond with: {"message": "No drivers available nearby. Please try again."}`;

      const response: GenerateContentResponse = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: 'OBJECT',
            properties: {
              driverName: { type: 'STRING' },
              driverRating: { type: 'NUMBER' },
              vehicleType: { type: 'STRING' },
              licensePlate: { type: 'STRING' },
              etaMinutes: { type: 'NUMBER' },
              estimatedFare: { type: 'NUMBER' },
              message: { type: 'STRING' } // For "no drivers" case
            },
          },
        },
      });
      const text = response.text?.trim();

      if (text) {
        try {
          const rideData = JSON.parse(text);
          if (rideData.message) {
            setApiResponse(rideData.message);
            setPassengerRideStatus(null); // No ride found
          } else {
            setCurrentRideOffer({ ...rideData, pickup: pickupLocation, destination: destination });
            setApiResponse(`রাইড অফার পাওয়া গেছে! ড্রাইভার ${rideData.driverName} ${rideData.etaMinutes} মিনিট দূরে আছে।`);
            setPassengerRideStatus('found');
          }
        } catch (jsonError) {
          console.error("Failed to parse AI response JSON:", jsonError, text);
          setApiResponse("একটি প্রতিক্রিয়া পাওয়া গেছে, কিন্তু রাইডের বিস্তারিত তথ্য পার্স করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।");
          setPassengerRideStatus(null);
        }
      } else {
        setApiResponse("রাইড খুঁজে পেতে AI থেকে কোনো প্রতিক্রিয়া নেই। অনুগ্রহ করে আবার চেষ্টা করুন।");
        setPassengerRideStatus(null);
      }
    } catch (apiError: any) {
      console.error("Gemini API error (find ride):", apiError);
      setError(`রাইড খুঁজে পেতে ব্যর্থ: ${apiError.message || 'অজানা ত্রুটি'}`);
      setPassengerRideStatus(null);
    } finally {
      setLoading(false);
    }
  };

  const handlePassengerAcceptRide = () => {
    if (currentRideOffer) {
      setPassengerRideStatus('tracking');
      setApiResponse(`আপনি রাইডটি গ্রহণ করেছেন! ড্রাইভার ${currentRideOffer.driverName} আসছে।`);
    }
  };

  const handlePassengerCancelRide = () => {
    setPassengerRideStatus('canceled');
    setCurrentRideOffer(null);
    setApiResponse("রাইড বাতিল করা হয়েছে।");
  };

  const handlePassengerCompleteRide = () => {
    setPassengerRideStatus('completed');
    setApiResponse("রাইড সম্পন্ন হয়েছে! আপনার ড্রাইভারকে রেটিং দিন।");
    setCurrentRideOffer(null);
  }


  const handleDriverToggleOnline = () => {
    if (!isOnline) {
      setError("আপনি অফলাইন। অনলাইন স্ট্যাটাস পরিবর্তন করা সম্ভব নয়।");
      return;
    }
    const newStatus = driverStatus === 'offline' ? 'online' : 'offline';
    setDriverStatus(newStatus);
    setApiResponse(newStatus === 'online' ? 'আপনি অনলাইন আছেন। রাইড রিকোয়েস্টের জন্য অপেক্ষা করছেন...' : 'আপনি অফলাইন।');
    setError('');
    setLoading(false);
    setCurrentRideOffer(null); // Clear any pending requests
  };

  const handleDriverAcceptRide = () => {
    if (currentRideOffer) {
      setDriverStatus('on_ride');
      setApiResponse(`রাইড গ্রহণ করা হয়েছে! যাত্রী ${currentRideOffer.pickup} থেকে ${currentRideOffer.destination} পর্যন্ত যাবে।`);
      setPickupLocation(currentRideOffer.pickup); // Set for mock tracking
      setDestination(currentRideOffer.destination); // Set for mock tracking
    }
  };

  const handleDriverDeclineRide = () => {
    setDriverStatus('online'); // Go back to online, waiting for next request
    setApiResponse('রাইড প্রত্যাখ্যান করা হয়েছে। পরবর্তী রিকোয়েস্টের জন্য অপেক্ষা করা হচ্ছে...');
    setCurrentRideOffer(null);
  };

  const handleDriverCompleteRide = () => {
    setDriverStatus('ride_completed');
    setApiResponse("রাইড সম্পন্ন হয়েছে! আপনি ৳" + currentRideOffer?.estimatedFare?.toFixed(2) + " উপার্জন করেছেন। যাত্রীকে রেটিং দিন।");
    setCurrentRideOffer(null);
  }

  const initializeChat = async () => {
    if (!apiKey) {
      setError("এপিআই কী কনফিগার করা নেই। চ্যাট শুরু করা সম্ভব নয়।");
      return;
    }
    if (!isOnline) {
      setError("আপনি অফলাইন। চ্যাট সহকারী উপলব্ধ নয়।");
      return;
    }
    if (!chatRef.current) {
      const ai = new GoogleGenAI({ apiKey: apiKey });
      chatRef.current = ai.chats.create({
        model: 'gemini-2.5-flash',
        config: {
          systemInstruction: 'আপনি যাত্রী এবং ড্রাইভার উভয়ের জন্য একজন বন্ধুত্বপূর্ণ, সহায়ক এবং সংক্ষিপ্ত রাইড-শেয়ারিং সহকারী। ছোট, সরাসরি উত্তর দিন।',
        },
      });
      setChatMessages([{ sender: 'ai', text: 'নমস্কার! আজ আপনার রাইড সম্পর্কে কীভাবে সাহায্য করতে পারি?' }]);
    }
  };

  const handleSendChatMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    if (!isOnline) {
      setError("আপনি অফলাইন। চ্যাট বার্তা পাঠানো সম্ভব নয়।");
      return;
    }

    const userMessage = chatInput;
    setChatMessages((prev) => [...prev, { sender: 'user', text: userMessage }]);
    setChatInput('');
    setError('');

    if (!chatRef.current) {
      await initializeChat();
      if (!chatRef.current) {
        setChatMessages((prev) => [...prev, { sender: 'ai', text: 'দুঃখিত, আমি চ্যাট সহকারী শুরু করতে পারিনি। অনুগ্রহ করে আপনার সংযোগ পরীক্ষা করুন।' }]);
        return;
      }
    }

    try {
      const streamResponse = await chatRef.current.sendMessageStream({ message: userMessage });
      let aiResponseText = '';
      setChatMessages((prev) => [...prev, { sender: 'ai', text: <LoadingSpinner message="ভাবছি..." /> }]); // Placeholder for streaming

      for await (const chunk of streamResponse) {
        const c = chunk as GenerateContentResponse;
        if (c.text) {
          aiResponseText += c.text;
          setChatMessages((prev) => {
            const newMessages = [...prev];
            // Replace loading spinner with actual text
            if (newMessages.length > 0 && typeof newMessages[newMessages.length - 1].text !== 'string') {
                newMessages[newMessages.length - 1] = { sender: 'ai', text: aiResponseText };
            } else if (newMessages.length > 0 && newMessages[newMessages.length - 1].sender === 'ai') {
                newMessages[newMessages.length - 1] = { sender: 'ai', text: aiResponseText };
            } else {
                newMessages.push({sender: 'ai', text: aiResponseText});
            }
            return newMessages;
          });
        }
      }
    } catch (chatError: any) {
      console.error("Gemini Chat API error:", chatError);
      setError("চ্যাট সহকারী থেকে প্রতিক্রিয়া পেতে ব্যর্থ।");
      setChatMessages((prev) => {
        const newMessages = [...prev];
        const lastMessage = newMessages[newMessages.length - 1];
        if (lastMessage && lastMessage.sender === 'ai' && (typeof lastMessage.text !== 'string' || lastMessage.text === '...')) {
          newMessages[newMessages.length - 1] = { sender: 'ai', text: 'দুঃখিত, একটি ত্রুটি হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।' };
        } else {
          newMessages.push({ sender: 'ai', text: 'দুঃখিত, একটি ত্রুটি হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।' });
        }
        return newMessages;
      });
    }
  };

  const handleToggleChat = async () => {
    setIsChatOpen((prev) => !prev);
    if (!isChatOpen && !chatRef.current) { // If opening chat and not initialized
      await initializeChat();
    }
  };

  const resetAppState = () => {
    setUserMode('none');
    setPickupLocation(currentLocation);
    setDestination('');
    setDriverStatus('offline');
    setPassengerRideStatus(null);
    setCurrentRideOffer(null);
    setApiResponse('');
    setError('');
    setLoading(false);
    if (driverRequestIntervalRef.current) {
      clearInterval(driverRequestIntervalRef.current);
      driverRequestIntervalRef.current = null;
    }
    if (rideTrackingIntervalRef.current) {
      clearInterval(rideTrackingIntervalRef.current);
      rideTrackingIntervalRef.current = null;
    }
  };


  if (!apiKey) {
    return (
      <div id="root" className="error animate-fade-in" role="alert">
        <h1>RideShare AI App</h1>
        <p>ত্রুটি: Gemini API কী কনফিগার করা নেই। নিশ্চিত করুন `process.env.API_KEY` সেট করা আছে।</p>
      </div>
    );
  }

  return (
    <div id="root" role="main" aria-live="polite">
      <h1>RideShare AI App</h1>

      {!isOnline && (
        <p className="offline-message animate-fade-in" role="alert">
          আপনি বর্তমানে অফলাইন। সম্পূর্ণ কার্যকারিতার জন্য অনুগ্রহ করে ইন্টারনেটের সাথে সংযুক্ত হন।
        </p>
      )}

      {userMode === 'none' && (
        <div className="role-selection-card animate-fade-in">
          <h2>আপনার ভূমিকা নির্বাচন করুন</h2>
          <p>আপনি রাইডের জন্য যাত্রী নাকি রাইড প্রদানকারী ড্রাইভার, তা নির্বাচন করুন।</p>
          <div className="button-group">
            <button
              onClick={() => setUserMode('passenger')}
              aria-label="Select Passenger Mode"
              disabled={loading || !isOnline}
            >
              <span className="icon">🚶</span> আমি যাত্রী
            </button>
            <button
              onClick={() => setUserMode('driver')}
              aria-label="Select Driver Mode"
              className="secondary"
              disabled={loading || !isOnline}
            >
              <span className="icon">🚗</span> আমি ড্রাইভার
            </button>
          </div>
        </div>
      )}

      {userMode !== 'none' && (
        <div className="dashboard-container animate-slide-in-up">
          <div className="dashboard-header">
            <h2>{userMode === 'passenger' ? 'যাত্রী ড্যাশবোর্ড' : 'ড্রাইভার ড্যাশবোর্ড'}</h2>
            <p className="text-light-color">বর্তমান অবস্থান: {currentLocation || "আনা হচ্ছে..."}</p>
          </div>

          {userMode === 'passenger' && (
            <>
              {passengerRideStatus === 'searching' && <LoadingSpinner message="কাছাকাছি ড্রাইভার খুঁজছি..." />}
              {passengerRideStatus !== 'tracking' && passengerRideStatus !== 'completed' && (
                <>
                  <MockMap pickup={pickupLocation} destination={destination} />

                  <div className="input-group">
                    <label htmlFor="pickupLocation">পিক-আপ অবস্থান:</label>
                    <input
                      id="pickupLocation"
                      type="text"
                      value={pickupLocation}
                      onChange={(e) => setPickupLocation(e.target.value)}
                      placeholder="আপনার বর্তমান অবস্থান"
                      aria-label="আপনার পিক-আপ অবস্থান লিখুন"
                      disabled={loading || !isOnline}
                    />
                  </div>
                  <div className="input-group">
                    <label htmlFor="destination">গন্তব্য:</label>
                    <input
                      id="destination"
                      type="text"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder="আপনি কোথায় যেতে চান?"
                      aria-label="আপনার গন্তব্য লিখুন"
                      disabled={loading || !isOnline}
                    />
                  </div>
                  <div className="input-group">
                    <label>যানের ধরন:</label>
                    <select
                      value={vehicleType}
                      onChange={(e) => setVehicleType(e.target.value as VehicleType)}
                      disabled={loading || !isOnline}
                      aria-label="যানের ধরন নির্বাচন করুন"
                    >
                      <option value="Car">গাড়ি</option>
                      <option value="Bike">মোটরসাইকেল</option>
                    </select>
                  </div>
                  <div className="input-group">
                    <label>পেমেন্ট পদ্ধতি:</label>
                    <select
                      value={paymentMethod}
                      onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                      disabled={loading || !isOnline}
                      aria-label="পেমেন্ট পদ্ধতি নির্বাচন করুন"
                    >
                      <option value="Cash">ক্যাশ</option>
                      <option value="Wallet">ওয়ালেট</option>
                    </select>
                  </div>
                  <div className="button-group">
                    <button onClick={handleFindRide} disabled={loading || !isOnline || !pickupLocation || !destination} aria-busy={loading}>
                      <span className="icon">🔎</span> {loading ? 'রাইড খুঁজছি...' : 'রাইড খুঁজুন'}
                    </button>
                    <button onClick={resetAppState} className="outline" aria-label="ভূমিকায় ফিরে যান">
                      <span className="icon">↩️</span> ফিরে যান
                    </button>
                  </div>
                </>
              )}

              {passengerRideStatus === 'found' && currentRideOffer && (
                <div className="ride-offer-card animate-fade-in">
                  <h3>রাইড অফার পাওয়া গেছে!</h3>
                  <p className="ride-details">ড্রাইভার: <span>{currentRideOffer.driverName}</span> <span className="rating-stars">{'⭐'.repeat(Math.floor(currentRideOffer.driverRating))}</span> ({currentRideOffer.driverRating})</p>
                  <p className="ride-details">যান: <span>{currentRideOffer.vehicleType} - {currentRideOffer.licensePlate}</span></p>
                  <p className="ride-details">ETA: <span>{currentRideOffer.etaMinutes} মিনিট</span></p>
                  <p className="ride-details">আনুমানিক ভাড়া: <span>৳{currentRideOffer.estimatedFare.toFixed(2)}</span> ({paymentMethod})</p>
                  <div className="button-group">
                    <button onClick={handlePassengerAcceptRide} disabled={loading || !isOnline}>
                      <span className="icon">✅</span> রাইড গ্রহণ করুন
                    </button>
                    <button onClick={handlePassengerCancelRide} className="danger" disabled={loading || !isOnline}>
                      <span className="icon">❌</span> বাতিল করুন
                    </button>
                  </div>
                </div>
              )}

              {passengerRideStatus === 'tracking' && currentRideOffer && (
                <div className="animate-fade-in">
                  <MockMap pickup={currentRideOffer.pickup} destination={currentRideOffer.destination} status="tracking" />
                  <div className="message-card">
                    <h3>আপনার রাইড আসছে!</h3>
                    <p>{apiResponse}</p>
                    <p className="ride-details">ড্রাইভার: <span>{currentRideOffer.driverName}</span></p>
                    <p className="ride-details">যান: <span>{currentRideOffer.vehicleType} - {currentRideOffer.licensePlate}</span></p>
                    <div className="button-group">
                        <button onClick={handlePassengerCompleteRide} className="secondary" disabled={!isOnline}>
                            <span className="icon">🏁</span> রাইড সম্পন্ন (মক)
                        </button>
                        <button className="danger outline" disabled={!isOnline}>
                            <span className="icon">🚨</span> জরুরি অবস্থা
                        </button>
                    </div>
                  </div>
                </div>
              )}

              {passengerRideStatus === 'completed' && (
                <div className="message-card animate-fade-in">
                  <h3>রাইড সম্পন্ন হয়েছে!</h3>
                  <p>আমাদের সাথে রাইড করার জন্য ধন্যবাদ। আপনার ড্রাইভারকে রেটিং দিতে পারেন।</p>
                  <div className="button-group">
                    <button className="secondary" disabled={!isOnline}>
                        <span className="icon">⭐</span> ড্রাইভারকে রেটিং দিন
                    </button>
                    <button onClick={resetAppState} className="outline" disabled={!isOnline}>
                      <span className="icon">🏠</span> হোম
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {userMode === 'driver' && (
            <>
              <div className="driver-toggle animate-fade-in">
                <button
                  onClick={handleDriverToggleOnline}
                  className={driverStatus === 'offline' ? '' : 'secondary'}
                  disabled={loading || !isOnline}
                  aria-checked={driverStatus !== 'offline'}
                  role="switch"
                  aria-label={driverStatus === 'offline' ? 'অনলাইন যান' : 'অফলাইন যান'}
                >
                  <span className="icon">{driverStatus === 'offline' ? '🔴' : '🟢'}</span>
                  {driverStatus === 'offline' ? 'অনলাইন যান' : 'অফলাইন যান'}
                </button>
                <button onClick={resetAppState} className="outline" aria-label="ভূমিকায় ফিরে যান" disabled={loading}>
                  <span className="icon">↩️</span> ফিরে যান
                </button>
              </div>

              {loading && driverStatus === 'online' && <LoadingSpinner message="রাইড রিকোয়েস্ট খুঁজছি..." />}
              {(driverStatus === 'online' && !currentRideOffer && !loading) && <p className="animate-fade-in">আপনি অনলাইন। রাইড রিকোয়েস্টের জন্য অপেক্ষা করছেন...</p>}
              {(driverStatus === 'on_ride' || driverStatus === 'ride_completed') && (
                <MockMap pickup={pickupLocation} destination={destination} status={driverStatus === 'on_ride' ? 'tracking' : 'completed'} />
              )}

              {currentRideOffer && driverStatus === 'request_pending' && (
                <div className="ride-request-card animate-fade-in">
                  <h3>নতুন রাইড রিকোয়েস্ট!</h3>
                  <p className="ride-details">যাত্রী: <span>{currentRideOffer.passengerName}</span> <span className="rating-stars">{'⭐'.repeat(Math.floor(currentRideOffer.passengerRating || 0))}</span> ({currentRideOffer.passengerRating})</p>
                  <p className="ride-details">থেকে: <span>{currentRideOffer.pickup}</span></p>
                  <p className="ride-details">পর্যন্ত: <span>{currentRideOffer.destination}</span></p>
                  <p className="ride-details">আনুমানিক ভাড়া: <span>৳{currentRideOffer.estimatedFare?.toFixed(2)}</span></p>
                  <div className="button-group">
                    <button onClick={handleDriverAcceptRide} disabled={loading || !isOnline}>
                      <span className="icon">✅</span> গ্রহণ করুন
                    </button>
                    <button onClick={handleDriverDeclineRide} className="outline" disabled={loading || !isOnline}>
                      <span className="icon">❌</span> প্রত্যাখ্যান করুন
                    </button>
                  </div>
                </div>
              )}

              {driverStatus === 'on_ride' && currentRideOffer && (
                <div className="message-card animate-fade-in">
                  <h3>রাইডে আছেন!</h3>
                  <p>যাত্রী {currentRideOffer.pickup} থেকে {currentRideOffer.destination} পর্যন্ত নিয়ে যাওয়া হচ্ছে।</p>
                  <p>বর্তমান উপার্জন: <span>৳{currentRideOffer.estimatedFare?.toFixed(2)}</span></p>
                  <div className="button-group">
                    <button onClick={handleDriverCompleteRide} className="secondary" disabled={!isOnline}>
                      <span className="icon">🏁</span> রাইড সম্পন্ন
                    </button>
                  </div>
                </div>
              )}

              {driverStatus === 'ride_completed' && (
                <div className="message-card animate-fade-in">
                  <h3>রাইড সম্পন্ন হয়েছে!</h3>
                  <p>{apiResponse}</p>
                  <div className="button-group">
                    <button className="secondary" disabled={!isOnline}>
                        <span className="icon">⭐</span> যাত্রীকে রেটিং দিন
                    </button>
                    <button onClick={() => setDriverStatus('online')} className="outline" disabled={!isOnline}>
                      <span className="icon">🔄</span> আবার অনলাইন যান
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="error animate-fade-in" role="alert">{error}</p>}
          {apiResponse && userMode !== 'none' && (!currentRideOffer || driverStatus === 'online' || passengerRideStatus === 'canceled' || passengerRideStatus === 'completed' || driverStatus === 'ride_completed') && (
            <div className="message-card animate-fade-in" aria-live="polite">
                <p><strong>স্ট্যাটাস:</strong></p>
                <p>{apiResponse}</p>
            </div>
          )}
        </div>
      )}

      {/* Chat Assistant FAB */}
      <div className="chat-fab-container">
        <button className="chat-fab-button" onClick={handleToggleChat} aria-expanded={isChatOpen} aria-controls="chat-window" aria-label="এআই অ্যাসিস্ট্যান্ট চ্যাট চালু/বন্ধ করুন">
          💬
        </button>
        <div id="chat-window" className={`chat-window ${isChatOpen ? 'open' : ''}`}>
          <div className="chat-header">
            <span>এআই সহকারী</span>
            <button onClick={handleToggleChat} aria-label="চ্যাট বন্ধ করুন">×</button>
          </div>
          <div className="chat-messages-area" role="log" aria-live="polite">
            {chatMessages.map((msg, index) => (
              <div key={index} className={`chat-message ${msg.sender}`} aria-label={`${msg.sender === 'user' ? 'আপনি বললেন:' : 'এআই বললো:'} ${typeof msg.text === 'string' ? msg.text : 'চিন্তা করছে...'}`}>
                {msg.text}
              </div>
            ))}
            <div ref={chatMessagesEndRef} />
          </div>
          <form onSubmit={handleSendChatMessage} className="chat-input-form">
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="যেকোনো কিছু জিজ্ঞাসা করুন..."
              aria-label="এআই সহকারীকে আপনার বার্তা টাইপ করুন"
              disabled={!isOnline}
            />
            <button type="submit" disabled={!isOnline || !chatInput.trim()}>পাঠান</button>
          </form>
        </div>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
if (container) {
  const root = ReactDOM.createRoot(container);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  console.error("Failed to find the root element.");
}