import ReceiptContact from "./models/receipt-contact"
import ReceiptChallenge from "./models/receipt-challenge"
import ReceiptSnapshot from "./models/receipt-snapshot"
import { MedusaService } from "@medusajs/framework/utils"
import Campaign from "./models/campaign"
import Attribution from "./models/attribution"
import CartLifecycle from "./models/cart-lifecycle"
import CommunicationEvent from "./models/communication-event"
import CommunicationFlow from "./models/communication-flow"
import CustomerPhoneObservation from "./models/customer-phone-observation"
import CustomerPhoneRecommendation from "./models/customer-phone-recommendation"
import CustomerProfile from "./models/customer-profile"
import EmailTemplate from "./models/email-template"
import EventDelivery from "./models/event-delivery"
import FlowEnrollment from "./models/flow-enrollment"
import IdentityMap from "./models/identity-map"
import ImportRun from "./models/import-run"
import LinkClick from "./models/link-click"
import MessageLog from "./models/message-log"
import PhoneNumberIntelligence from "./models/phone-number-intelligence"
import Segment from "./models/segment"
import SegmentMember from "./models/segment-member"
import SmsProgramSuppression from "./models/sms-program-suppression"
import SuppressionPreference from "./models/suppression-preference"

class GpCommunicationsModuleService extends MedusaService({
  Attribution,
  ReceiptContact,
  ReceiptChallenge,
  ReceiptSnapshot,
  Campaign,
  CartLifecycle,
  CommunicationEvent,
  CommunicationFlow,
  CustomerPhoneObservation,
  CustomerPhoneRecommendation,
  CustomerProfile,
  EmailTemplate,
  EventDelivery,
  FlowEnrollment,
  IdentityMap,
  ImportRun,
  LinkClick,
  MessageLog,
  PhoneNumberIntelligence,
  Segment,
  SegmentMember,
  SmsProgramSuppression,
  SuppressionPreference,
}) {}

export default GpCommunicationsModuleService
