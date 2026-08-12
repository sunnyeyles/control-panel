import { normalizeTitle } from "@workspace/job-search/title-exclusions"

/**
 * The role titles the new-briefing form completes against, and the rule that
 * matches them.
 *
 * A checked-in list rather than a lookup: a title becomes a literal query
 * string handed to SEEK, Indeed and LinkedIn, and the completion has to answer
 * on the keystroke — a round trip to `iad1` lags behind typing.
 *
 * ⚠️ **The import is `@workspace/job-search/title-exclusions`, never the
 * package root.** The root barrel re-exports `job-search-config.ts`, which
 * imports `@workspace/agents`; reaching this module through the barrel from a
 * client component would pull LangChain into the `/jobs/schedules` chunk.
 *
 * A starting point, not a taxonomy — the field always accepts free text, and
 * nothing here filters or validates what a user types. Written in blocks by
 * family, with the seniority ladder applied rather than spelled out and only to
 * the titles that carry one.
 */

/**
 * Prefixes that combine with {@link LADDERED_TITLES}.
 *
 * Ordered as a career, not alphabetically, so a diff reads as the ladder it is.
 * The generator includes the unprefixed title, so "Software Engineer" needs no
 * entry here.
 */
const SENIORITY_LADDER = [
  "Graduate",
  "Junior",
  "Mid-Level",
  "Senior",
  "Lead",
  "Staff",
  "Principal",
] as const

/**
 * Titles a seniority prefix makes sense in front of.
 *
 * Kept deliberately short: every entry becomes eight strings, and padding the
 * list with "Graduate Solutions Architect" pushes the real answers off the end
 * of the eight rows the field shows.
 */
const LADDERED_TITLES = [
  "Software Engineer",
  "Software Developer",
  "Backend Engineer",
  "Backend Developer",
  "Frontend Engineer",
  "Frontend Developer",
  "Full Stack Engineer",
  "Full Stack Developer",
  "Mobile Developer",
  "iOS Developer",
  "Android Developer",
  "Platform Engineer",
  "Infrastructure Engineer",
  "DevOps Engineer",
  "Site Reliability Engineer",
  "Cloud Engineer",
  "Data Engineer",
  "Data Scientist",
  "Data Analyst",
  "Analytics Engineer",
  "Machine Learning Engineer",
  "Security Engineer",
  "QA Engineer",
  "Test Engineer",
  "Automation Engineer",
  "Product Manager",
  "Product Designer",
  "UX Designer",
  "UI Designer",
  "Business Analyst",
  "Systems Engineer",
  "Network Engineer",
  "Database Administrator",
  "Integration Engineer",
  "Embedded Software Engineer",
  "Game Developer",
  "Accountant",
  "Financial Analyst",
  "Marketing Manager",
  "Project Manager",
  "Registered Nurse",
  "Civil Engineer",
  "Mechanical Engineer",
  "Electrical Engineer",
  "Structural Engineer",
] as const

/** Software engineering, by specialism rather than by ladder. */
const ENGINEERING_TITLES = [
  "API Developer",
  "Application Developer",
  "Application Support Engineer",
  "Blockchain Developer",
  "Build Engineer",
  "C# Developer",
  "C++ Developer",
  "Compiler Engineer",
  "Computer Vision Engineer",
  "Developer Advocate",
  "Developer Experience Engineer",
  "Django Developer",
  "Elixir Developer",
  "Firmware Engineer",
  "Flutter Developer",
  "Go Developer",
  "Graphics Engineer",
  "Java Developer",
  "JavaScript Developer",
  "Kotlin Developer",
  "Laravel Developer",
  "Node.js Developer",
  "PHP Developer",
  "Performance Engineer",
  "Python Developer",
  "React Developer",
  "React Native Developer",
  "Release Engineer",
  "Ruby Developer",
  "Ruby on Rails Developer",
  "Rust Developer",
  "Salesforce Developer",
  "Scala Developer",
  "ServiceNow Developer",
  "Sharepoint Developer",
  "Software Architect",
  "Software Engineer in Test",
  "Solutions Architect",
  "Solutions Engineer",
  "Swift Developer",
  "Systems Programmer",
  "Technical Architect",
  "Technical Consultant",
  "Technical Lead",
  "Tools Engineer",
  "TypeScript Developer",
  "Unity Developer",
  "Vue Developer",
  "Web Developer",
  "WordPress Developer",
] as const

/** Data, analytics and machine learning. */
const DATA_TITLES = [
  "AI Engineer",
  "Applied Scientist",
  "BI Analyst",
  "BI Developer",
  "Business Intelligence Analyst",
  "Business Intelligence Developer",
  "Chief Data Officer",
  "Computational Linguist",
  "Data Architect",
  "Data Governance Analyst",
  "Data Platform Engineer",
  "Data Quality Analyst",
  "Data Steward",
  "Data Warehouse Engineer",
  "Database Developer",
  "Decision Scientist",
  "Deep Learning Engineer",
  "ETL Developer",
  "Head of Data",
  "Insights Analyst",
  "MLOps Engineer",
  "Machine Learning Scientist",
  "NLP Engineer",
  "Power BI Developer",
  "Quantitative Analyst",
  "Reporting Analyst",
  "Research Scientist",
  "Statistician",
  "Tableau Developer",
] as const

/** Infrastructure, cloud and operations. */
const INFRASTRUCTURE_TITLES = [
  "AWS Engineer",
  "Azure Engineer",
  "Cloud Architect",
  "Cloud Security Engineer",
  "Cloud Solutions Architect",
  "Database Reliability Engineer",
  "Enterprise Architect",
  "GCP Engineer",
  "Head of Infrastructure",
  "Head of Platform",
  "Infrastructure Architect",
  "Kubernetes Engineer",
  "Linux Administrator",
  "Linux Engineer",
  "Network Administrator",
  "Network Architect",
  "Observability Engineer",
  "Platform Architect",
  "Production Engineer",
  "Systems Administrator",
  "Systems Architect",
  "Virtualisation Engineer",
  "Windows Administrator",
] as const

/** Security. */
const SECURITY_TITLES = [
  "Application Security Engineer",
  "Chief Information Security Officer",
  "Cyber Security Analyst",
  "Cyber Security Consultant",
  "Cyber Security Engineer",
  "Detection Engineer",
  "GRC Analyst",
  "Identity and Access Management Engineer",
  "Incident Response Analyst",
  "Information Security Analyst",
  "Information Security Manager",
  "Penetration Tester",
  "Red Team Operator",
  "Security Analyst",
  "Security Architect",
  "Security Consultant",
  "Security Operations Analyst",
  "Threat Intelligence Analyst",
  "Vulnerability Analyst",
] as const

/** Quality and test. */
const QUALITY_TITLES = [
  "Performance Test Engineer",
  "QA Analyst",
  "QA Lead",
  "QA Manager",
  "Quality Analyst",
  "Quality Assurance Engineer",
  "Software Tester",
  "Test Analyst",
  "Test Automation Engineer",
  "Test Lead",
  "Test Manager",
] as const

/** Product, design and research. */
const PRODUCT_TITLES = [
  "Brand Designer",
  "Chief Product Officer",
  "Content Designer",
  "Design Lead",
  "Design Manager",
  "Design Researcher",
  "Digital Designer",
  "Graphic Designer",
  "Group Product Manager",
  "Head of Design",
  "Head of Product",
  "Industrial Designer",
  "Interaction Designer",
  "Motion Designer",
  "Product Analyst",
  "Product Marketing Manager",
  "Product Operations Manager",
  "Product Owner",
  "Service Designer",
  "Technical Product Manager",
  "UX Researcher",
  "UX Writer",
  "UX/UI Designer",
  "Visual Designer",
  "Web Designer",
] as const

/** Engineering leadership. */
const LEADERSHIP_TITLES = [
  "Chief Executive Officer",
  "Chief Information Officer",
  "Chief Operating Officer",
  "Chief Technology Officer",
  "Delivery Lead",
  "Development Manager",
  "Director of Engineering",
  "Engineering Manager",
  "General Manager",
  "Head of Engineering",
  "Head of Technology",
  "IT Director",
  "IT Manager",
  "Practice Lead",
  "Team Lead",
  "Technology Manager",
  "VP of Engineering",
] as const

/** Delivery, project and change. */
const DELIVERY_TITLES = [
  "Agile Coach",
  "Change Manager",
  "Delivery Manager",
  "Digital Project Manager",
  "IT Project Manager",
  "Portfolio Manager",
  "Process Analyst",
  "Program Manager",
  "Project Coordinator",
  "Project Officer",
  "Release Manager",
  "Requirements Analyst",
  "Scrum Master",
  "Service Delivery Manager",
  "Systems Analyst",
  "Technical Business Analyst",
  "Technical Program Manager",
  "Technical Writer",
  "Transformation Manager",
] as const

/** IT support and service. */
const SUPPORT_TITLES = [
  "Application Support Analyst",
  "Customer Success Manager",
  "Customer Support Specialist",
  "Desktop Support Technician",
  "Field Service Technician",
  "Help Desk Analyst",
  "IT Support Officer",
  "IT Support Technician",
  "Service Desk Analyst",
  "Support Engineer",
  "Technical Support Engineer",
  "Technical Support Specialist",
] as const

/** Sales, marketing and growth. */
const COMMERCIAL_TITLES = [
  "Account Executive",
  "Account Manager",
  "Business Development Manager",
  "Category Manager",
  "Communications Manager",
  "Content Marketing Manager",
  "Content Writer",
  "Copywriter",
  "Digital Marketing Manager",
  "Digital Marketing Specialist",
  "Ecommerce Manager",
  "Enterprise Account Executive",
  "Events Manager",
  "Growth Manager",
  "Growth Marketing Manager",
  "Head of Growth",
  "Head of Marketing",
  "Inside Sales Representative",
  "Marketing Coordinator",
  "Marketing Specialist",
  "Media Buyer",
  "Partnerships Manager",
  "Public Relations Manager",
  "Sales Director",
  "Sales Engineer",
  "Sales Manager",
  "Sales Representative",
  "SEO Specialist",
  "Social Media Manager",
] as const

/** Finance, legal and risk. */
const FINANCE_TITLES = [
  "Accounts Payable Officer",
  "Accounts Receivable Officer",
  "Actuary",
  "Assistant Accountant",
  "Auditor",
  "Bookkeeper",
  "Chief Financial Officer",
  "Commercial Analyst",
  "Compliance Manager",
  "Compliance Officer",
  "Contracts Administrator",
  "Corporate Lawyer",
  "Credit Analyst",
  "Finance Business Partner",
  "Finance Manager",
  "Financial Accountant",
  "Financial Controller",
  "Financial Planner",
  "Fund Accountant",
  "Investment Analyst",
  "Investment Manager",
  "Legal Counsel",
  "Management Accountant",
  "Paralegal",
  "Payroll Officer",
  "Risk Analyst",
  "Risk Manager",
  "Solicitor",
  "Tax Accountant",
  "Treasury Analyst",
] as const

/** People, talent and administration. */
const PEOPLE_TITLES = [
  "Administration Officer",
  "Chief People Officer",
  "Employee Relations Advisor",
  "Executive Assistant",
  "HR Advisor",
  "HR Business Partner",
  "HR Coordinator",
  "HR Manager",
  "Head of People",
  "Learning and Development Manager",
  "Office Manager",
  "People and Culture Manager",
  "Personal Assistant",
  "Recruitment Consultant",
  "Recruitment Manager",
  "Remuneration and Benefits Specialist",
  "Talent Acquisition Partner",
  "Talent Acquisition Specialist",
  "Technical Recruiter",
  "Workplace Health and Safety Officer",
] as const

/** Operations, supply chain and logistics. */
const OPERATIONS_TITLES = [
  "Business Operations Manager",
  "Contract Manager",
  "Demand Planner",
  "Distribution Manager",
  "Fleet Manager",
  "Inventory Controller",
  "Logistics Coordinator",
  "Logistics Manager",
  "Operations Analyst",
  "Operations Coordinator",
  "Operations Manager",
  "Procurement Manager",
  "Procurement Officer",
  "Production Manager",
  "Quality Manager",
  "Supply Chain Analyst",
  "Supply Chain Manager",
  "Warehouse Manager",
  "Warehouse Supervisor",
] as const

/** Health and community services. */
const HEALTH_TITLES = [
  "Aged Care Worker",
  "Clinical Nurse",
  "Clinical Nurse Consultant",
  "Clinical Psychologist",
  "Dental Assistant",
  "Dietitian",
  "Disability Support Worker",
  "Enrolled Nurse",
  "Exercise Physiologist",
  "General Practitioner",
  "Medical Receptionist",
  "Mental Health Clinician",
  "Midwife",
  "Nurse Practitioner",
  "Nurse Unit Manager",
  "Occupational Therapist",
  "Optometrist",
  "Paramedic",
  "Pharmacist",
  "Physiotherapist",
  "Psychologist",
  "Radiographer",
  "Social Worker",
  "Sonographer",
  "Speech Pathologist",
  "Support Coordinator",
  "Veterinarian",
  "Youth Worker",
] as const

/** Education and research. */
const EDUCATION_TITLES = [
  "Academic Advisor",
  "Curriculum Developer",
  "Early Childhood Educator",
  "Education Support Officer",
  "High School Teacher",
  "Instructional Designer",
  "Learning Designer",
  "Lecturer",
  "Postdoctoral Researcher",
  "Primary School Teacher",
  "Research Assistant",
  "Research Fellow",
  "School Principal",
  "Special Education Teacher",
  "Teaching Assistant",
  "Training Coordinator",
  "Tutor",
  "VET Trainer",
] as const

/** Trades, construction and property. */
const TRADES_TITLES = [
  "Architect",
  "Boilermaker",
  "Building Surveyor",
  "Cabinet Maker",
  "Carpenter",
  "Concreter",
  "Construction Manager",
  "Contract Administrator",
  "Diesel Mechanic",
  "Draftsperson",
  "Electrician",
  "Estimator",
  "Facilities Manager",
  "Fitter and Turner",
  "Landscaper",
  "Leading Hand",
  "Mechanical Fitter",
  "Painter",
  "Plumber",
  "Project Engineer",
  "Property Manager",
  "Quantity Surveyor",
  "Refrigeration Technician",
  "Site Manager",
  "Site Supervisor",
  "Surveyor",
  "Welder",
] as const

/** Science, mining and primary industry. */
const SCIENCE_TITLES = [
  "Agronomist",
  "Biomedical Engineer",
  "Chemical Engineer",
  "Chemist",
  "Environmental Consultant",
  "Environmental Scientist",
  "Geologist",
  "Geotechnical Engineer",
  "Hydrogeologist",
  "Laboratory Technician",
  "Marine Engineer",
  "Metallurgist",
  "Microbiologist",
  "Mining Engineer",
  "Process Engineer",
  "Quality Assurance Officer",
  "Research Technician",
  "Water Engineer",
] as const

/** Hospitality, retail and services. */
const SERVICE_TITLES = [
  "Barista",
  "Bartender",
  "Chef",
  "Chef de Partie",
  "Cleaner",
  "Concierge",
  "Cook",
  "Customer Service Officer",
  "Customer Service Representative",
  "Duty Manager",
  "Event Coordinator",
  "Front Office Manager",
  "Hotel Manager",
  "Kitchen Hand",
  "Restaurant Manager",
  "Retail Assistant",
  "Retail Manager",
  "Sous Chef",
  "Store Manager",
  "Travel Consultant",
  "Venue Manager",
  "Waiter",
] as const

/** Transport, safety and public service. */
const PUBLIC_TITLES = [
  "Bus Driver",
  "Crane Operator",
  "Emergency Services Officer",
  "Firefighter",
  "Forklift Operator",
  "Heavy Vehicle Driver",
  "Machine Operator",
  "Plant Operator",
  "Policy Adviser",
  "Policy Analyst",
  "Policy Officer",
  "Program Coordinator",
  "Security Officer",
  "Town Planner",
  "Traffic Controller",
  "Transport Planner",
  "Truck Driver",
  "Urban Planner",
] as const

/**
 * Every title the field completes against, sorted, with the ladder expanded.
 *
 * Sorted once at module scope rather than per keystroke, and the sort is what
 * makes the alphabetical tiebreak in {@link matchRoleTitles} free.
 */
export const ROLE_TITLES: readonly string[] = [
  ...LADDERED_TITLES.flatMap((title) => [
    title,
    ...SENIORITY_LADDER.map((rank) => `${rank} ${title}`),
  ]),
  ...ENGINEERING_TITLES,
  ...DATA_TITLES,
  ...INFRASTRUCTURE_TITLES,
  ...SECURITY_TITLES,
  ...QUALITY_TITLES,
  ...PRODUCT_TITLES,
  ...LEADERSHIP_TITLES,
  ...DELIVERY_TITLES,
  ...SUPPORT_TITLES,
  ...COMMERCIAL_TITLES,
  ...FINANCE_TITLES,
  ...PEOPLE_TITLES,
  ...OPERATIONS_TITLES,
  ...HEALTH_TITLES,
  ...EDUCATION_TITLES,
  ...TRADES_TITLES,
  ...SCIENCE_TITLES,
  ...SERVICE_TITLES,
  ...PUBLIC_TITLES,
].sort((left, right) => left.localeCompare(right))

/**
 * The tokens of every title, in the same order as {@link ROLE_TITLES}.
 *
 * Computed once because the alternative is normalising eight hundred titles on
 * every keystroke, and `normalizeTitle` runs a Unicode regex over each.
 */
const ROLE_TITLE_TOKENS: readonly (readonly string[])[] = ROLE_TITLES.map(
  (title) => titleTokens(title)
)

/**
 * A title as a list of words, under the same rule the **Title Filter** uses.
 *
 * `normalizeTitle` is reused rather than reimplemented so "Node.js Developer"
 * tokenises here exactly as it does where a posting is matched against an
 * exclusion; a second normalisation would drift from the first.
 */
function titleTokens(title: string): string[] {
  const normalized = normalizeTitle(title).trim()
  return normalized.length === 0 ? [] : normalized.split(" ")
}

/**
 * Every title by its normalised form, for the snap in
 * {@link canonicalRoleTitle}.
 */
const BY_NORMALIZED: ReadonlyMap<string, string> = new Map(
  ROLE_TITLES.map((title) => [normalizeTitle(title), title])
)

/**
 * A title as this list spells it, when the list has an opinion.
 *
 * **For the model's suggestions, not the user's typing.** Two agents propose
 * titles and nothing constrains them to a shared vocabulary; "Full Stack" vs
 * "Full-Stack" gives the user two buttons for one role, spending two sweeps of
 * three boards out of a budget of three titles. Snapping can only change
 * punctuation and case — `normalizeTitle` flattens both — and a title the list
 * has never heard of comes back as given.
 *
 * ⚠️ **Never applied to what the user typed.** A field that quietly rewrote a
 * title on submit would be an autocomplete that could not be declined.
 */
export function canonicalRoleTitle(title: string): string {
  return BY_NORMALIZED.get(normalizeTitle(title)) ?? title.trim()
}

/**
 * Below this, everything matches and the list is noise rather than a
 * completion. Two characters is where "so" stops meaning anything and "sof"
 * starts.
 */
const MIN_FRAGMENT_CHARS = 2

/**
 * Whether `fragment`'s words appear, in order, as prefixes of `title`'s words.
 *
 * **In order**: `software en` finds "Software Engineer"; `en software` finds
 * nothing, because nobody types a title's words backwards. Words rather than a
 * whole-string prefix, so `engineer` reaches "Data Engineer".
 *
 * Returns the index of the title word the *first* fragment word matched, or
 * `-1`. That index is the ranking signal — a match at word 0 beats one at
 * word 3.
 */
function matchPosition(
  fragmentTokens: readonly string[],
  candidateTokens: readonly string[]
): number {
  let first = -1
  let cursor = 0

  for (const token of fragmentTokens) {
    let found = -1

    while (cursor < candidateTokens.length) {
      const candidate = candidateTokens[cursor]
      cursor += 1

      if (candidate?.startsWith(token)) {
        found = cursor - 1
        break
      }
    }

    if (found === -1) return -1
    if (first === -1) first = found
  }

  return first
}

/**
 * The titles worth offering for what has been typed so far.
 *
 * Deterministic by design — no model, no network, no tunable heuristic. The AI
 * suggestions beside this field are the other half, and they get to be
 * inventive precisely because this half never is.
 *
 * Ranked by match position, then by title length ("Data Engineer" before "Data
 * Platform Engineer"), then alphabetically — free, since {@link ROLE_TITLES} is
 * sorted and the sort is stable.
 */
export function matchRoleTitles(fragment: string, limit = 8): string[] {
  const tokens = titleTokens(fragment)
  if (fragment.trim().length < MIN_FRAGMENT_CHARS || tokens.length === 0) {
    return []
  }

  const hits: { title: string; position: number; length: number }[] = []

  for (const [index, titleTokenList] of ROLE_TITLE_TOKENS.entries()) {
    const position = matchPosition(tokens, titleTokenList)
    if (position === -1) continue

    const title = ROLE_TITLES[index]
    if (title === undefined) continue

    hits.push({ title, position, length: title.length })
  }

  hits.sort(
    (left, right) =>
      left.position - right.position || left.length - right.length
  )

  return hits.slice(0, limit).map((hit) => hit.title)
}

/** One row of the completion list: what it says, and what picking it means. */
export interface RoleTitleCompletion {
  /** The bare title, shown as the option's label. */
  title: string
  /** The whole field value picking this option produces. */
  value: string
}

/**
 * The completions for a comma-separated field, as whole replacement values.
 *
 * ⚠️ **A `<datalist>` matches its options against the *entire* input value, not
 * the word being typed.** Bare titles match nothing once the field holds
 * `"Software Engineer, "` — the browser compares the whole value against the
 * option. So each option carries the full string the field *becomes*, and
 * picking one is a replacement rather than an append. The bare title travels
 * alongside as the label, which is what Firefox displays.
 *
 * Separated from the component so the caret arithmetic is testable: getting it
 * wrong offers nothing rather than raising an error.
 */
export function roleTitleCompletions(
  value: string,
  limit = 8
): RoleTitleCompletion[] {
  const cut = value.lastIndexOf(",")
  const committed = cut === -1 ? "" : value.slice(0, cut).trim()
  const fragment = value.slice(cut + 1).trim()
  const prefix = committed.length === 0 ? "" : `${committed}, `

  return matchRoleTitles(fragment, limit).map((title) => ({
    title,
    value: `${prefix}${title}`,
  }))
}
