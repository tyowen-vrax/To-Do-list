/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import copy from 'copy-to-clipboard';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User, setPersistence, browserLocalPersistence } from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  getDoc, 
  onSnapshot, 
  collection, 
  query, 
  where, 
  writeBatch,
  deleteDoc,
  getDocs,
  getDocFromServer,
  deleteField
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

// ... existing imports ...
import { 
  ChevronLeft, 
  ChevronRight, 
  Edit2, 
  Plus, 
  Check, 
  Trash2, 
  Calendar, 
  ChevronDown, 
  ChevronUp,
  Archive,
  X,
  GripVertical,
  Star,
  Download,
  Copy,
  ExternalLink,
  RotateCcw
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import { 
  format, 
  startOfWeek, 
  addDays, 
  subWeeks, 
  addWeeks, 
  isSameDay, 
  isAfter, 
  startOfDay,
  startOfMonth,
  getYear,
  differenceInCalendarDays,
  isToday,
  isTomorrow
} from 'date-fns';

// --- Types ---

type Priority = 'High' | 'Med' | 'Low' | 'None';

interface SubTask {
  id: string;
  text: string;
  completed: boolean;
}

interface Task {
  id: string;
  text: string;
  completed: boolean;
  priority?: Priority;
  deadline?: string;
  repeatMonthly?: boolean;
  monthlyRepeatType?: 'day' | 'nthWeekday';
  monthlyRepeatNth?: number | 'last';
  monthlyRepeatWeekday?: number;
  completedAt?: string;
  section: 'daily' | 'monthly' | 'projects' | 'other';
  order: number;
  subtasks?: SubTask[];
}

interface CalendarEvent {
  id: string;
  text: string;
  dayOfWeek: number; // 0-6
  repeatWeekly: boolean;
  date?: string; // If not repeating, the specific date
  endDate?: string; // For multi-day events
  time?: string;
}

interface HistoryItem {
  id: string;
  text: string;
  completedAt: string;
  section: string;
  priority?: Priority;
  savedForYearlyReview?: boolean;
}

interface DashboardState {
  title: string;
  goals: string[];
  tasks: Task[];
  calendarEvents: CalendarEvent[];
  history: HistoryItem[];
  archives: Record<string, { id: string, items: HistoryItem[] }>; // Maps title to entry
  eventExceptions: string[]; // Format: eventId:yyyy-MM-dd
  lastDailyReset: string;
  lastMonthlyReset: string;
}

// --- Constants ---

const PRIORITY_ORDER: Record<string, number> = {
  'High': 3,
  'Med': 2,
  'Low': 1,
  'None': 0
};

const sortTasks = (tasks: Task[]) => {
  return [...tasks].sort((a, b) => {
    // 1. Time Sorting (if deadline has time)
    // User requested: "In the daily checklist and monthly don't order the tasks by time just leave them how they are"
    const canTimeSort = a.section !== 'daily' && a.section !== 'monthly' && b.section !== 'daily' && b.section !== 'monthly';

    if (canTimeSort) {
      const getDeadlineTime = (d?: any) => (typeof d === 'string' && d.includes('T')) ? d.split('T')[1] : null;
      const timeA = getDeadlineTime(a.deadline);
      const timeB = getDeadlineTime(b.deadline);

      if (timeA || timeB) {
        if (timeA && timeB) return timeA.localeCompare(timeB);
        return timeA ? -1 : 1;
      }
    }

    const weightA = PRIORITY_ORDER[a.priority || 'None'] || 0;
    const weightB = PRIORITY_ORDER[b.priority || 'None'] || 0;
    
    if (weightA !== weightB) {
      return weightB - weightA; // Higher weight first
    }
    return a.order - b.order; // Then manual order
  });
};

const PriorityBadge = ({ priority }: { priority?: Priority }) => {
  if (!priority || priority === 'None') return null;
  return (
    <span className={`text-[8px] font-black px-1 py-0.5 rounded border uppercase tracking-tighter flex-shrink-0 ${
      priority === 'High' ? 'bg-red-50 text-red-600 border-red-200' :
      priority === 'Med' ? 'bg-amber-50 text-amber-600 border-amber-200' :
      'bg-blue-50 text-blue-600 border-blue-200'
    }`}>
      {priority === 'Med' ? 'Medium' : priority}
    </span>
  );
};

const PrioritySelect = ({ task, onSetPriority }: { task: Task, onSetPriority: (id: string, p: Priority) => void }) => (
  <select 
    className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded border uppercase tracking-tighter cursor-pointer outline-none transition-colors ${
      task.priority === 'High' ? 'bg-red-50 text-red-600 border-red-200' :
      task.priority === 'Med' ? 'bg-amber-50 text-amber-600 border-amber-200' :
      task.priority === 'Low' ? 'bg-blue-50 text-blue-600 border-blue-200' :
      'bg-slate-50 text-slate-300 border-slate-100'
    }`}
    value={task.priority}
    onChange={(e) => onSetPriority(task.id, e.target.value as Priority)}
  >
    <option value="None">None</option>
    <option value="High">High</option>
    <option value="Med">Medium</option>
    <option value="Low">Low</option>
  </select>
);

const INITIAL_STATE: DashboardState = {
  title: "My To-Do List",
  goals: ['', '', '', '', '', ''],
  tasks: [],
  calendarEvents: [],
  history: [],
  archives: {},
  eventExceptions: [],
  lastDailyReset: format(new Date(), 'yyyy-MM-dd'),
  lastMonthlyReset: format(new Date(), 'yyyy-MM-01'),
};

// --- Firebase Initialization ---

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Error handling helper
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Components ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const [state, setState] = useState<DashboardState>(INITIAL_STATE);

    // Auth Listener
  useEffect(() => {
    const initAuth = async () => {
      try {
        await setPersistence(auth, browserLocalPersistence);
      } catch (err) {
        console.error("Auth persistence error", err);
      }
    };
    initAuth();

    return onAuthStateChanged(auth, (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
      } else {
        setUser(null);
        setState(INITIAL_STATE);
      }
      setIsLoadingAuth(false);
    });
  }, []);

  const login = async () => {
    try {
      setIsLoadingAuth(true);
      await setPersistence(auth, browserLocalPersistence);
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login failed", error);
      setIsLoadingAuth(false);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
      setState(INITIAL_STATE);
    } catch (error) {
      console.error("Logout failed", error);
    }
  };

  // Firestore Sync
  useEffect(() => {
    if (!user) return;

    const userDocRef = doc(db, 'users', user.uid);
    
    // Test connection
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    // Listen to main user settings
    const unsubSettings = onSnapshot(userDocRef, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setState(prev => ({
          ...prev,
          title: data.title,
          goals: data.goals,
          lastDailyReset: data.lastDailyReset,
          lastMonthlyReset: data.lastMonthlyReset,
        }));
      } else {
        // Initial setup for new user
        setDoc(userDocRef, {
          title: INITIAL_STATE.title,
          goals: INITIAL_STATE.goals,
          lastDailyReset: INITIAL_STATE.lastDailyReset,
          lastMonthlyReset: INITIAL_STATE.lastMonthlyReset,
        }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
      }
    }, (err) => handleFirestoreError(err, OperationType.GET, `users/${user.uid}`));

    // Listen to subcollections
    const unsubTasks = onSnapshot(collection(db, `users/${user.uid}/tasks`), (snap) => {
      const tasks = sortTasks(snap.docs.map(d => d.data() as Task));
      setState(prev => ({ ...prev, tasks }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/tasks`));

    const unsubCalendar = onSnapshot(collection(db, `users/${user.uid}/calendarEvents`), (snap) => {
      const calendarEvents = snap.docs.map(d => d.data() as CalendarEvent);
      setState(prev => ({ ...prev, calendarEvents }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/calendarEvents`));

    const unsubHistory = onSnapshot(collection(db, `users/${user.uid}/history`), (snap) => {
      const history = snap.docs.map(d => d.data() as HistoryItem);
      setState(prev => ({ ...prev, history }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/history`));

    const unsubArchives = onSnapshot(collection(db, `users/${user.uid}/archives`), (snap) => {
      const archives: Record<string, { id: string, items: HistoryItem[] }> = {};
      snap.docs.forEach(d => {
        const data = d.data();
        archives[data.title] = { id: d.id, items: data.items };
      });
      setState(prev => ({ ...prev, archives }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/archives`));

    const unsubExceptions = onSnapshot(collection(db, `users/${user.uid}/eventExceptions`), (snap) => {
      const eventExceptions = snap.docs.map(d => d.data().exceptionKey as string);
      setState(prev => ({ ...prev, eventExceptions }));
    }, (err) => handleFirestoreError(err, OperationType.LIST, `users/${user.uid}/eventExceptions`));

    return () => {
      unsubSettings();
      unsubTasks();
      unsubCalendar();
      unsubHistory();
      unsubArchives();
      unsubExceptions();
    };
  }, [user]);

  const [currentWeekStart, setCurrentWeekStart] = useState(() => startOfWeek(new Date()));
  const [isHistoryOpen, setIsHistoryOpen] = useState(true);
  const [isYearlyReviewOpen, setIsYearlyReviewOpen] = useState(false);
  const [historySnapshot, setHistorySnapshot] = useState<HistoryItem[] | null>(null);
  const [lastArchiveId, setLastArchiveId] = useState<string | null>(null);
  const [showUndo, setShowUndo] = useState(false);
  const [editingArchiveTitle, setEditingArchiveTitle] = useState<string | null>(null);
  const [openArchives, setOpenArchives] = useState<Record<string, boolean>>({});
  const [collapsedMonths, setCollapsedMonths] = useState<Record<string, boolean>>({});
  const [editingGoalIndex, setEditingGoalIndex] = useState<number | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isDeadlineModalOpen, setIsDeadlineModalOpen] = useState(false);
  const [taskForDeadline, setTaskForDeadline] = useState<{id: string, priority: Priority, section?: Task['section']} | null>(null);
  const [eventToDelete, setEventToDelete] = useState<{id: string, date?: string} | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [newEvent, setNewEvent] = useState({ 
    text: '', 
    dayIndex: 0, 
    repeatWeekly: false, 
    time: '',
    startDate: format(new Date(), 'yyyy-MM-dd'),
    endDate: format(new Date(), 'yyyy-MM-dd'),
    isMultiDay: false
  });

  const [activeAddingSection, setActiveAddingSection] = useState<Task['section'] | null>(null);
  const [newTaskText, setNewTaskText] = useState('');
  
  const [taskToConfirmDelete, setTaskToConfirmDelete] = useState<string | null>(null);
  const [isTaskDeleteModalOpen, setIsTaskDeleteModalOpen] = useState(false);
  const [historyItemToDelete, setHistoryItemToDelete] = useState<string | null>(null);
  const [isHistoryDeleteModalOpen, setIsHistoryDeleteModalOpen] = useState(false);
  const [isYearlyReviewModalOpen, setIsYearlyReviewModalOpen] = useState(false);
  const [tempDeadlineDate, setTempDeadlineDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [tempDeadlineTime, setTempDeadlineTime] = useState('');
  const [tempRepeatMonthly, setTempRepeatMonthly] = useState(false);
  const [tempMonthlyRepeatType, setTempMonthlyRepeatType] = useState<'day' | 'nthWeekday'>('day');
  const [tempMonthlyRepeatNth, setTempMonthlyRepeatNth] = useState<number | 'last'>(1);
  const [tempMonthlyRepeatWeekday, setTempMonthlyRepeatWeekday] = useState<number>(1);

  // Persistence
  useEffect(() => {
    localStorage.setItem('bento_planner_data', JSON.stringify(state));
  }, [state]);

  // Check resets on mount
  useEffect(() => {
    if (!user) return;
    const now = new Date();
    const todayStr = format(now, 'yyyy-MM-dd');
    const monthStr = format(now, 'yyyy-MM-01');

    if (state.lastDailyReset !== todayStr || state.lastMonthlyReset !== monthStr) {
      const userDocRef = doc(db, 'users', user.uid);
      const batch = writeBatch(db);
      
      const updates: any = {};
      
      if (state.lastDailyReset !== todayStr) {
        state.tasks.forEach(t => {
          if (t.section === 'daily' && t.completed) {
            batch.update(doc(db, `users/${user.uid}/tasks`, t.id), { completed: false });
          }
        });
        updates.lastDailyReset = todayStr;
      }

      if (state.lastMonthlyReset !== monthStr) {
        state.tasks.forEach(t => {
          if (t.section === 'monthly' && t.completed) {
            batch.update(doc(db, `users/${user.uid}/tasks`, t.id), { completed: false });
          }
        });
        updates.lastMonthlyReset = monthStr;
      }

      if (Object.keys(updates).length > 0) {
        batch.update(userDocRef, updates);
        batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/resets`));
      }
    }
  }, [user, state.lastDailyReset, state.lastMonthlyReset]);

  // --- Handlers ---

  const handleUpdateTitle = async (text: string) => {
    if (user) {
      const userDocRef = doc(db, 'users', user.uid);
      await setDoc(userDocRef, { title: text }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
    }
    setEditingTitle(false);
  };

  const handleUpdateGoal = async (index: number, text: string) => {
    const newGoals = [...state.goals];
    newGoals[index] = text;
    if (user) {
      const userDocRef = doc(db, 'users', user.uid);
      await setDoc(userDocRef, { goals: newGoals }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}`));
    }
    setEditingGoalIndex(null);
  };

  const handleUpdateTaskText = async (taskId: string, text: string) => {
    if (!text.trim()) {
      removeTask(taskId);
      return;
    }
    
    // Optimistic update
    setState(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id === taskId ? { ...t, text } : t)
    }));

    if (user) {
      const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
      await setDoc(taskRef, { text }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));
    }
    setEditingTaskId(null);
  };

  const handleReorderTasks = (newOrder: Task[], section: Task['section']) => {
    // Optimistic local update
    const updatedNewOrder = newOrder.map((t, index) => ({ ...t, order: index }));
    
    setState(prev => {
      const otherTasks = prev.tasks.filter(t => t.section !== section);
      return {
        ...prev,
        tasks: sortTasks([...otherTasks, ...updatedNewOrder])
      };
    });

    if (user) {
      // Debounce logic or just batch commit. 
      // For now, let's ensure we don't start multiple overlapping reorders if possible.
      const syncReorder = async () => {
        const batch = writeBatch(db);
        updatedNewOrder.forEach((task) => {
          const taskRef = doc(db, `users/${user.uid}/tasks`, task.id);
          batch.update(taskRef, { order: task.order });
        });
        await batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks_reorder`));
      };
      
      // We could debounce here, but let's see if optimistic update alone fixes the "not great" feel.
      syncReorder();
    }
  };

  const restoreTask = async (taskId: string) => {
    const task = state.history.find(t => t.id === taskId);
    if (!task || !user) return;

    const section = (task.section as Task['section']) || 'other';
    const sectionTasks = state.tasks.filter(t => t.section === section);
    const maxOrder = sectionTasks.length > 0 
      ? Math.max(...sectionTasks.map(t => t.order))
      : -1;

    const newTask: Task = { 
      id: task.id, 
      text: task.text, 
      completed: false, 
      section: section,
      priority: task.priority || 'None',
      order: maxOrder + 1
    };

    // Optimistic update
    setState(prev => ({
      ...prev,
      history: prev.history.filter(t => t.id !== taskId),
      tasks: sortTasks([...prev.tasks, newTask])
    }));

    const batch = writeBatch(db);
    const historyRef = doc(db, `users/${user.uid}/history`, taskId);
    const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);

    batch.delete(historyRef);
    batch.set(taskRef, newTask);

    await batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks_restore`));
  };

  const handleUpdateSubTasks = async (taskId: string, subtasks: SubTask[]) => {
    if (user) {
      const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
      await setDoc(taskRef, { subtasks }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));
    }
  };

  const handleUpdateHistoryTask = async (taskId: string, newText: string) => {
    if (user) {
      const historyRef = doc(db, `users/${user.uid}/history`, taskId);
      await setDoc(historyRef, { text: newText }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/history/${taskId}`));
    }
    setEditingTaskId(null);
  };

  const handleUpdateHistoryDate = async (id: string, newDate: string) => {
    const date = new Date(newDate);
    if (isNaN(date.getTime()) || !user) return;
    
    const historyRef = doc(db, `users/${user.uid}/history`, id);
    await setDoc(historyRef, { completedAt: date.toISOString() }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/history/${id}`));
  };

  const toggleYearlyReview = async (taskId: string) => {
    const item = state.history.find(t => t.id === taskId);
    if (!item || !user) return;

    const historyRef = doc(db, `users/${user.uid}/history`, taskId);
    await setDoc(historyRef, { savedForYearlyReview: !item.savedForYearlyReview }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/history/${taskId}`));
  };

  const removeTaskClick = (taskId: string) => {
    setTaskToConfirmDelete(taskId);
    setIsTaskDeleteModalOpen(true);
  };

  const confirmTaskDelete = async () => {
    if (taskToConfirmDelete && user) {
      const taskRef = doc(db, `users/${user.uid}/tasks`, taskToConfirmDelete);
      await deleteDoc(taskRef).catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/tasks/${taskToConfirmDelete}`));
    }
    setIsTaskDeleteModalOpen(false);
    setTaskToConfirmDelete(null);
  };

  const removeTask = async (taskId: string) => {
    if (user) {
      const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
      await deleteDoc(taskRef).catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/tasks/${taskId}`));
    }
  };

  const submitNewTask = async () => {
    if (!newTaskText.trim() || !activeAddingSection || !user) {
      setActiveAddingSection(null);
      setNewTaskText('');
      return;
    }

    const sectionTasks = state.tasks.filter(t => t.section === activeAddingSection);
    const maxOrder = sectionTasks.length > 0 
      ? Math.max(...sectionTasks.map(t => t.order))
      : -1;

    const taskId = Math.random().toString(36).substr(2, 9);
    const newTask: Task = {
      id: taskId,
      text: newTaskText.trim(),
      completed: false,
      section: activeAddingSection,
      order: maxOrder + 1
    };

    if (activeAddingSection === 'projects' || activeAddingSection === 'other') {
      newTask.priority = 'None';
    }

    // Optimistic update
    setState(prev => ({ ...prev, tasks: sortTasks([...prev.tasks, newTask]) }));

    const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
    await setDoc(taskRef, newTask).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));
    
    setActiveAddingSection(null);
    setNewTaskText('');
  };

  const toggleTask = async (taskId: string) => {
    const task = state.tasks.find(t => t.id === taskId);
    if (!task || !user) return;

    if (!task.completed && (task.section === 'projects' || task.section === 'other')) {
      const historyItem: HistoryItem = {
        id: task.id,
        text: task.text,
        completedAt: new Date().toISOString(),
        section: task.section,
        priority: task.priority || 'None'
      };
      
      // Optimistic update
      setState(prev => ({
        ...prev,
        tasks: prev.tasks.filter(t => t.id !== taskId),
        history: [...prev.history, historyItem]
      }));

      const batch = writeBatch(db);
      const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
      const historyRef = doc(db, `users/${user.uid}/history`, taskId);

      batch.delete(taskRef);
      batch.set(historyRef, historyItem);
      await batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks_complete`));
    } else {
      // Optimistic update
      setState(prev => ({
        ...prev,
        tasks: prev.tasks.map(t => t.id === taskId ? { ...t, completed: !t.completed } : t)
      }));

      const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);
      await setDoc(taskRef, { completed: !task.completed }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));
    }
  };

  const setPriority = async (taskId: string, priority: Priority) => {
    if (!user) return;
    const taskRef = doc(db, `users/${user.uid}/tasks`, taskId);

    // Optimistic update
    setState(prev => ({
      ...prev,
      tasks: sortTasks(prev.tasks.map(t => t.id === taskId ? { ...t, priority, deadline: priority === 'None' ? undefined : t.deadline } : t))
    }));

    if (priority === 'None') {
      await setDoc(taskRef, { priority, deadline: deleteField() }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));
      return;
    }

    const task = state.tasks.find(t => t.id === taskId);
    await setDoc(taskRef, { priority }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskId}`));

    if (task && !task.deadline) {
      if (confirm('Priority set! Would you like to add a due date?')) {
        openDeadlineModal(task);
      }
    }
  };

  const handleSetDeadline = async (date: string) => {
    if (!taskForDeadline || !user) return;
    const taskRef = doc(db, `users/${user.uid}/tasks`, taskForDeadline.id);
    await setDoc(taskRef, { 
      deadline: date,
      repeatMonthly: tempRepeatMonthly,
      monthlyRepeatType: tempRepeatMonthly ? tempMonthlyRepeatType : null,
      monthlyRepeatNth: tempRepeatMonthly && tempMonthlyRepeatType === 'nthWeekday' ? tempMonthlyRepeatNth : null,
      monthlyRepeatWeekday: tempRepeatMonthly && tempMonthlyRepeatType === 'nthWeekday' ? tempMonthlyRepeatWeekday : null
    }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskForDeadline.id}`));
    setIsDeadlineModalOpen(false);
    setTaskForDeadline(null);
    setTempDeadlineDate(format(new Date(), 'yyyy-MM-dd'));
    setTempDeadlineTime('');
    setTempRepeatMonthly(false);
    setTempMonthlyRepeatType('day');
    setTempMonthlyRepeatNth(1);
    setTempMonthlyRepeatWeekday(1);
  };

  const handleClearDeadline = async () => {
    if (!taskForDeadline || !user) return;
    const taskRef = doc(db, `users/${user.uid}/tasks`, taskForDeadline.id);
    await setDoc(taskRef, { 
      deadline: null,
      repeatMonthly: false,
      monthlyRepeatType: null,
      monthlyRepeatNth: null,
      monthlyRepeatWeekday: null
    }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/tasks/${taskForDeadline.id}`));
    setIsDeadlineModalOpen(false);
    setTaskForDeadline(null);
    setTempDeadlineDate(format(new Date(), 'yyyy-MM-dd'));
    setTempDeadlineTime('');
    setTempRepeatMonthly(false);
    setTempMonthlyRepeatType('day');
    setTempMonthlyRepeatNth(1);
    setTempMonthlyRepeatWeekday(1);
  };

  const openDeadlineModal = (task: Task) => {
    setTaskForDeadline({ id: task.id, priority: task.priority || 'None', section: task.section });
    if (task.deadline) {
      if (task.deadline.includes('T')) {
        const [date, time] = task.deadline.split('T');
        setTempDeadlineDate(date);
        setTempDeadlineTime(time);
      } else {
        setTempDeadlineDate(task.deadline);
        setTempDeadlineTime('');
      }
    } else {
      setTempDeadlineDate(format(new Date(), 'yyyy-MM-dd'));
      setTempDeadlineTime('');
    }
    const d = task.deadline ? new Date(task.deadline.includes('T') ? task.deadline : task.deadline.replace(/-/g, '/')) : new Date();
    setTempRepeatMonthly(!!task.repeatMonthly || task.section === 'monthly');
    setTempMonthlyRepeatNth(task.monthlyRepeatNth || Math.ceil(d.getDate() / 7));
    setTempMonthlyRepeatWeekday(task.monthlyRepeatWeekday !== undefined ? task.monthlyRepeatWeekday : d.getDay());
    setTempMonthlyRepeatType(task.monthlyRepeatType || 'day');
    setIsDeadlineModalOpen(true);
  };

  const addCalendarEvent = async () => {
    if (!newEvent.text || !user) return;
    const eventId = Math.random().toString(36).substr(2, 9);
    const event: any = {
      id: eventId,
      text: newEvent.text,
      dayOfWeek: newEvent.dayIndex,
      repeatWeekly: newEvent.repeatWeekly,
    };

    if (newEvent.time) {
      event.time = newEvent.time;
    }

    if (!newEvent.repeatWeekly) {
      if (newEvent.isMultiDay) {
        event.date = newEvent.startDate;
        event.endDate = newEvent.endDate;
      } else {
        event.date = format(addDays(currentWeekStart, newEvent.dayIndex), 'yyyy-MM-dd');
      }
    }
    
    const eventRef = doc(db, `users/${user.uid}/calendarEvents`, eventId);
    await setDoc(eventRef, event).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/calendarEvents/${eventId}`));
    
    setIsEventModalOpen(false);
    setNewEvent({ 
      text: '', 
      dayIndex: 0, 
      repeatWeekly: false, 
      time: '',
      startDate: format(new Date(), 'yyyy-MM-dd'),
      endDate: format(new Date(), 'yyyy-MM-dd'),
      isMultiDay: false
    });
  };

  const handleUpdateEventText = async (eventId: string, text: string) => {
    const finalTitle = text.trim() || 'Untitled';
    if (user) {
      const eventRef = doc(db, `users/${user.uid}/calendarEvents`, eventId);
      await setDoc(eventRef, { text: finalTitle }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/calendarEvents/${eventId}`));
    }
    setEditingEventId(null);
  };

  const removeEvent = async (eventId: string, date?: string) => {
    const event = state.calendarEvents.find(e => e.id === eventId);
    if (!event || !user) return;

    if ((event.repeatWeekly || event.endDate) && date) {
      setEventToDelete({ id: eventId, date });
      setIsDeleteModalOpen(true);
    } else {
      const eventRef = doc(db, `users/${user.uid}/calendarEvents`, eventId);
      await deleteDoc(eventRef).catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/calendarEvents/${eventId}`));
    }
  };

  const confirmDelete = async (type: 'one' | 'all') => {
    if (!eventToDelete || !user) return;

    if (type === 'one' && eventToDelete.date) {
      const exceptionKey = `${eventToDelete.id}:${eventToDelete.date}`;
      const exceptionId = Math.random().toString(36).substr(2, 9);
      const exceptionRef = doc(db, `users/${user.uid}/eventExceptions`, exceptionId);
      await setDoc(exceptionRef, { id: exceptionId, exceptionKey }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/eventExceptions/${exceptionId}`));
    } else {
      const batch = writeBatch(db);
      const eventRef = doc(db, `users/${user.uid}/calendarEvents`, eventToDelete.id);
      batch.delete(eventRef);
      
      // Clean up exceptions (optional but good)
      // For simplicity, we just delete the event
      await batch.commit().catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/calendar_delete_all`));
    }
    
    setIsDeleteModalOpen(false);
    setEventToDelete(null);
  };

  const finalizeYearlyReview = async () => {
    const yearlyItems = state.history.filter(t => t.savedForYearlyReview);
    if (yearlyItems.length === 0) {
      alert('No items are marked for yearly review. Star some accomplishments first!');
      return;
    }
    if (!user) return;

    const yearCounts: Record<number, number> = {};
    state.history.forEach(item => {
      const y = (() => {
        try {
          return getYear(new Date(item.completedAt));
        } catch {
          return new Date().getFullYear();
        }
      })();
      yearCounts[y] = (yearCounts[y] || 0) + 1;
    });
    const majorityYear = Object.keys(yearCounts).length > 0 
      ? Object.keys(yearCounts).reduce((a, b) => yearCounts[parseInt(a)] > yearCounts[parseInt(b)] ? a : b)
      : getYear(new Date()).toString();

    const defaultTitle = `Yearly Review ${majorityYear}`;
    
    // We archive everything in history when finalizing a "review" cycle
    const itemsToArchive = [...state.history];
    setHistorySnapshot(itemsToArchive);
    setShowUndo(true);
    setTimeout(() => setShowUndo(false), 10000); // 10 seconds

    const newArchives = { ...state.archives };
    let finalTitle = defaultTitle;
    let counter = 1;
    while (newArchives[finalTitle]) {
      finalTitle = `${defaultTitle} (${counter++})`;
    }

    const batch = writeBatch(db);
    const archiveId = Math.random().toString(36).substr(2, 9);
    setLastArchiveId(archiveId);
    const archiveRef = doc(db, `users/${user.uid}/archives`, archiveId);
    
    batch.set(archiveRef, { title: finalTitle, items: itemsToArchive });
    
    // Clear history
    itemsToArchive.forEach(item => {
      const historyRef = doc(db, `users/${user.uid}/history`, item.id);
      batch.delete(historyRef);
    });

    // Optimistic update
    setState(prev => ({ 
      ...prev, 
      history: [],
      archives: { ...prev.archives, [finalTitle]: { id: archiveId, items: itemsToArchive } }
    }));

    await batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/archives/${archiveId}`));
  };

  const handleUndoFinalize = async () => {
    if (historySnapshot && user) {
      // Optimistic update
      setState(prev => {
        const newArchives = { ...prev.archives };
        if (lastArchiveId) {
          // Find the entry with this ID to remove it
          const title = Object.keys(newArchives).find(t => newArchives[t].id === lastArchiveId);
          if (title) delete newArchives[title];
        }
        return {
          ...prev,
          history: historySnapshot,
          archives: newArchives
        };
      });

      const batch = writeBatch(db);
      if (lastArchiveId) {
        batch.delete(doc(db, `users/${user.uid}/archives`, lastArchiveId));
      }
      historySnapshot.forEach(item => {
        const historyRef = doc(db, `users/${user.uid}/history`, item.id);
        batch.set(historyRef, item);
      });
      await batch.commit().catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/undo_finalize`));
      
      setIsHistoryOpen(true);
      setIsYearlyReviewOpen(true);
      setHistorySnapshot(null);
      setLastArchiveId(null);
      setShowUndo(false);
    }
  };

  const copyToClipboard = async (title: string, items: HistoryItem[]) => {
    const highlights = items.filter(i => i.savedForYearlyReview);
    const others = items.filter(i => !i.savedForYearlyReview);

    const generateSection = (title: string, sectionItems: HistoryItem[]) => {
      const grouped = sectionItems.reduce((acc, item) => {
        const month = format(new Date(item.completedAt), 'MMMM yyyy');
        if (!acc[month]) acc[month] = [];
        acc[month].push(item);
        return acc;
      }, {} as Record<string, HistoryItem[]>);

      return `
        <h2 style="font-family: sans-serif; color: #000; border-bottom: 2px solid #000; padding-bottom: 4px; margin-top: 24px;">${title}</h2>
        ${Object.entries(grouped)
          .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
          .map(([month, monthItems]) => `
          <h3 style="font-family: sans-serif; color: #64748b; font-size: 14px; margin-top: 16px;">${month}</h3>
          <ul style="list-style: none; padding: 0;">
            ${monthItems.map(item => `
              <li style="font-family: sans-serif; margin-bottom: 4px;">• ${item.text}</li>
            `).join('')}
          </ul>
        `).join('')}
      `;
    };

    const html = `
      <div style="background: #fff; padding: 20px;">
        <h1 style="font-family: sans-serif; font-size: 24px; font-weight: 900; margin-bottom: 32px;">${title}</h1>
        ${highlights.length > 0 ? generateSection('Highlights', highlights) : ''}
        ${others.length > 0 ? generateSection('Other Accomplishments', others) : ''}
      </div>
    `;

    const blob = new Blob([html], { type: 'text/html' });
    const textBlob = new Blob([`${title}\n\nHighlights:\n${highlights.map(i => `• ${i.text}`).join('\n')}`], { type: 'text/plain' });
    
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': blob,
          'text/plain': textBlob
        })
      ]);
      alert('Copied to clipboard with formatting!');
    } catch (err) {
      console.error('Copy failed', err);
    }
  };

  const downloadAsHTML = (title: string, items: HistoryItem[]) => {
    const highlights = items.filter(i => i.savedForYearlyReview);
    const others = items.filter(i => !i.savedForYearlyReview);

    const generateSection = (header: string, sectionItems: HistoryItem[]) => {
      const grouped = sectionItems.reduce((acc, item) => {
        const month = format(new Date(item.completedAt), 'MMMM yyyy');
        if (!acc[month]) acc[month] = [];
        acc[month].push(item);
        return acc;
      }, {} as Record<string, HistoryItem[]>);

      return `
        <section>
          <h2>${header}</h2>
          ${Object.entries(grouped)
            .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
            .map(([month, monthItems]) => `
            <div class="month-block">
              <h3>${month}</h3>
              <ul>
                ${monthItems.map(item => `<li>${item.text}</li>`).join('')}
              </ul>
            </div>
          `).join('')}
        </section>
      `;
    };

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>${title}</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 40px; color: #1e293b; line-height: 1.6; max-width: 800px; margin: 0 auto; }
          h1 { font-size: 32px; font-weight: 900; text-transform: uppercase; border-left: 8px solid #facc15; padding-left: 16px; margin-bottom: 48px; }
          h2 { font-size: 18px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.1em; background: #facc15; display: inline-block; padding: 4px 12px; margin-top: 40px; }
          h3 { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.2em; border-bottom: 2px solid #0f172a; padding-bottom: 4px; }
          ul { list-style: none; padding: 0; }
          li { font-weight: 600; font-size: 14px; margin-bottom: 8px; text-transform: uppercase; }
          li::before { content: "• "; color: #94a3b8; }
          .month-block { margin-bottom: 32px; }
        </style>
      </head>
      <body>
        <h1>${title}</h1>
        ${highlights.length > 0 ? generateSection('Yearly Review Highlights', highlights) : ''}
        ${others.length > 0 ? generateSection('Other Things Done', others) : ''}
      </body>
      </html>
    `;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${title.replace(/\s+/g, '_')}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const deleteArchive = async (title: string) => {
    const archive = state.archives[title];
    if (archive && user && confirm(`Delete archive "${title}"?`)) {
      await deleteDoc(doc(db, `users/${user.uid}/archives`, archive.id)).catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/archives/${archive.id}`));
    }
  };

  const renameArchive = async (oldTitle: string, newTitle: string) => {
    if (!newTitle.trim() || oldTitle === newTitle || !user) {
      setEditingArchiveTitle(null);
      return;
    }
    
    const archive = state.archives[oldTitle];
    if (archive) {
      await setDoc(doc(db, `users/${user.uid}/archives`, archive.id), { title: newTitle }, { merge: true }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/archives/${archive.id}`));
    }
    setEditingArchiveTitle(null);
  };

  const removeHistoryItem = (itemId: string) => {
    setHistoryItemToDelete(itemId);
    setIsHistoryDeleteModalOpen(true);
  };

  const confirmHistoryDelete = async () => {
    if (user && historyItemToDelete) {
      await deleteDoc(doc(db, `users/${user.uid}/history`, historyItemToDelete)).catch(err => handleFirestoreError(err, OperationType.DELETE, `users/${user.uid}/history/${historyItemToDelete}`));
    }
    setIsHistoryDeleteModalOpen(false);
    setHistoryItemToDelete(null);
  };

  const deleteItemFromArchive = async (archiveId: string, itemId: string) => {
    if (!user) return;
    
    // Optimistic update
    setState(prev => {
      const newArchives = { ...prev.archives };
      const title = Object.keys(newArchives).find(t => newArchives[t].id === archiveId);
      if (title) {
        newArchives[title] = {
          ...newArchives[title],
          items: newArchives[title].items.filter(i => i.id !== itemId)
        };
      }
      return { ...prev, archives: newArchives };
    });

    const archiveRef = doc(db, `users/${user.uid}/archives`, archiveId);
    const snap = await getDoc(archiveRef).catch(err => handleFirestoreError(err, OperationType.GET, `users/${user.uid}/archives/${archiveId}`));
    
    if (snap && snap.exists()) {
      const data = snap.data();
      const updatedItems = (data.items || []).filter((i: any) => i.id !== itemId);
      await setDoc(archiveRef, { ...data, items: updatedItems }).catch(err => handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/archives/${archiveId}`));
    }
  };

  const restoreArchive = async (title: string) => {
    const archive = state.archives[title];
    if (!archive || !user) return;

    const archivedItems = archive.items;
    const archiveId = archive.id;

    // Optimistic update
    setState(prev => {
      const newArchives = { ...prev.archives };
      delete newArchives[title];
      return {
        ...prev,
        history: [...prev.history, ...archivedItems],
        archives: newArchives
      };
    });

    // Ensure the sections are open so user sees the restoration
    setIsHistoryOpen(true);
    setIsYearlyReviewOpen(true);

    const batch = writeBatch(db);
    archivedItems.forEach(item => {
      const historyRef = doc(db, `users/${user.uid}/history`, item.id);
      batch.set(historyRef, item);
    });
    batch.delete(doc(db, `users/${user.uid}/archives`, archiveId));
    
    try {
      await batch.commit();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `users/${user.uid}/restore_archive`);
    }
  };

  // --- Helpers ---

  const weekDays = useMemo(() => {
    return Array.from({ length: 7 }, (_, i) => addDays(currentWeekStart, i));
  }, [currentWeekStart]);

  const historyGroupedByMonth = useMemo(() => {
    const groups: { [key: string]: HistoryItem[] } = {};
    
    // Always include all months of current year
    const currentYear = new Date().getFullYear();
    for (let i = 0; i < 12; i++) {
      const month = format(new Date(currentYear, i, 1), 'MMMM yyyy');
      groups[month] = [];
    }

    state.history.forEach(item => {
      const month = format(new Date(item.completedAt), 'MMMM yyyy');
      if (!groups[month]) groups[month] = [];
      groups[month].push(item);
    });
    return groups;
  }, [state.history]);

  if (isLoadingAuth) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-slate-900 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm font-bold uppercase tracking-widest text-slate-400">Loading your focus...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-slate-50 p-4">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white p-12 rounded-3xl shadow-2xl max-w-md w-full text-center space-y-8"
        >
          <div className="w-20 h-20 bg-slate-900 rounded-3xl rotate-12 flex items-center justify-center mx-auto shadow-xl">
            <Check size={40} className="text-white -rotate-12" />
          </div>
          <div className="space-y-2">
            <h1 className="text-4xl font-black italic uppercase tracking-tighter text-slate-900">Bento Planner</h1>
            <p className="text-slate-400 font-medium tracking-tight">Your modular daily architecture.</p>
          </div>
          <button 
            onClick={login}
            className="w-full bg-slate-900 text-white py-4 rounded-2xl font-black uppercase tracking-widest text-sm flex items-center justify-center gap-3 hover:bg-slate-800 transition-all shadow-lg active:scale-95"
          >
            <Star size={18} fill="white" />
            Sign in with Google
          </button>
          <p className="text-[10px] text-slate-300 font-bold uppercase tracking-widest">Free • Secure • Cloud Synced</p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto p-4 md:p-6 space-y-6 pb-20">
      {/* --- Sign Out --- */}
      <div className="flex justify-start">
        <button 
          onClick={logout}
          className="text-[10px] font-black uppercase tracking-widest text-slate-300 hover:text-slate-900 transition-colors flex items-center gap-2 px-2 py-1"
        >
          <X size={12} />
          Sign Out
        </button>
      </div>

      {/* --- Header Section --- */}
      <header className="flex flex-col lg:flex-row gap-6 items-stretch">
        {/* Goals Card (Left) */}
        <div className="flex-1 bento-card p-5">
           <h2 className="text-xl font-extrabold text-slate-900 uppercase tracking-tight mb-4">
             Goals
           </h2>
           <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
             {state.goals.map((goal, idx) => (
                <div key={idx} className="flex items-center space-x-2 text-sm group group-hover:text-slate-900 transition-colors">
                  <span className="text-slate-300">•</span>
                  {editingGoalIndex === idx ? (
                    <input
                      autoFocus
                      className="flex-1 bg-transparent border-b border-slate-200 outline-none py-0.5"
                      defaultValue={goal}
                      onBlur={(e) => handleUpdateGoal(idx, e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleUpdateGoal(idx, e.currentTarget.value)}
                    />
                  ) : (
                    <div className="flex-1 flex items-center justify-between min-w-0">
                      <span className={`truncate ${goal ? 'text-slate-700 font-medium' : 'text-slate-400 italic'}`}>
                        {goal || 'Click to add...'}
                      </span>
                      <button onClick={() => setEditingGoalIndex(idx)} className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5">
                        <Edit2 size={10} className="text-slate-400" />
                      </button>
                    </div>
                  )}
                </div>
             ))}
           </div>
        </div>

        {/* Title & Actions (Right) */}
        <div className="lg:w-72 flex flex-col justify-between items-end text-right py-2">
           <div className="group">
             {editingTitle ? (
               <input
                 autoFocus
                 className="text-4xl font-black italic bg-transparent border-b-2 border-slate-900 outline-none text-right uppercase"
                 defaultValue={state.title}
                 onBlur={(e) => handleUpdateTitle(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && handleUpdateTitle(e.currentTarget.value)}
               />
             ) : (
               <div className="flex items-start justify-end gap-2">
                 <h1 className="text-4xl font-black italic tracking-tighter uppercase cursor-pointer" onClick={() => setEditingTitle(true)}>
                    {state.title}
                 </h1>
                 <button onClick={() => setEditingTitle(true)} className="opacity-0 group-hover:opacity-100 p-1">
                   <Edit2 size={16} className="text-slate-400" />
                 </button>
               </div>
             )}
             <p className="text-base text-slate-400 font-medium mt-1">
               {format(new Date(), 'MMMM d, yyyy')}
             </p>
           </div>
           

        </div>
      </header>

      {/* --- Weekly Calendar Grid --- */}
      <section className="space-y-4">
        <div className="flex items-center justify-between px-2">
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
            <Calendar size={14} />
            Weekly Overview
          </h2>
          <div className="flex items-center bg-white border border-slate-100 rounded-lg p-1 shadow-sm gap-1">
            <button onClick={() => setCurrentWeekStart(subWeeks(currentWeekStart, 1))} className="p-1 px-2 hover:bg-slate-50 rounded transition-colors text-slate-600">←</button>
            <button 
              onClick={() => setCurrentWeekStart(startOfWeek(new Date()))} 
              className="px-2 py-1 text-[10px] font-bold uppercase bg-slate-100 hover:bg-slate-200 text-slate-600 rounded transition-colors"
            >
              Today
            </button>
            <span className="px-2 text-[10px] font-bold uppercase tracking-tighter text-slate-400">
              {format(currentWeekStart, 'MMM d')} - {format(addDays(currentWeekStart, 6), 'MMM d')}
            </span>
            <button onClick={() => setCurrentWeekStart(addWeeks(currentWeekStart, 1))} className="p-1 px-2 hover:bg-slate-50 rounded transition-colors text-slate-600">→</button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
          {weekDays.map((day, idx) => {
            const dateStr = format(day, 'yyyy-MM-dd');
            const dayEvents = state.calendarEvents
              .filter(e => {
                let isCorrectDay = false;
                if (e.repeatWeekly) {
                  isCorrectDay = e.dayOfWeek === idx;
                } else if (e.endDate) {
                  // Multi-day event
                  const start = new Date(e.date!);
                  const end = new Date(e.endDate);
                  const current = new Date(dateStr);
                  isCorrectDay = current >= start && current <= end;
                } else {
                  isCorrectDay = e.date === dateStr;
                }
                
                const isExcluded = state.eventExceptions.includes(`${e.id}:${dateStr}`);
                return isCorrectDay && !isExcluded;
              })
              .sort((a, b) => {
                try {
                  const tA = typeof a.time === 'string' ? a.time : '';
                  const tB = typeof b.time === 'string' ? b.time : '';
                  if (tA && tB) return tA.localeCompare(tB);
                  if (tA) return -1;
                  if (tB) return 1;
                  return 0;
                } catch {
                  return 0;
                }
              });
            const isToday = isSameDay(day, new Date());
            return (
              <div key={idx} className={`bento-card p-4 min-h-[140px] flex flex-col group relative overflow-hidden transition-all duration-300 ${isToday ? 'border-slate-900 ring-4 ring-slate-900/5 bg-slate-50/50' : 'hover:border-slate-300'}`}>
                {isToday && (
                  <div className="absolute top-0 left-0 w-full h-1 bg-slate-900" />
                )}
                <div className="flex justify-between items-start mb-3 border-b border-slate-100 pb-2">
                  <div className="flex flex-col">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[10px] uppercase font-black tracking-widest ${isToday ? 'text-slate-900' : 'text-slate-400'}`}>
                        {format(day, 'EEE')}
                      </span>
                      {isToday && (
                        <span className="bg-slate-900 text-white text-[7px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter">
                          Today
                        </span>
                      )}
                    </div>
                    <span className={`text-2xl font-black leading-none mt-1 ${isToday ? 'text-slate-900' : 'text-slate-600'}`}>
                      {format(day, 'd')}
                    </span>
                  </div>
                  <button 
                    onClick={() => {
                      const clickedDate = format(addDays(currentWeekStart, idx), 'yyyy-MM-dd');
                      setNewEvent(prev => ({ 
                        ...prev, 
                        dayIndex: idx,
                        startDate: clickedDate,
                        endDate: clickedDate
                      }));
                      setIsEventModalOpen(true);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-slate-100 rounded transition-opacity"
                  >
                    <Plus size={14} className="text-slate-400" />
                  </button>
                </div>
                
                <div className="flex-1 space-y-1 scrollbar-none">
                  {dayEvents.map(event => (
                    <div 
                      key={event.id} 
                      className={`text-[10px] p-1 rounded-md flex flex-col gap-0 group/item transition-colors border ${
                        event.endDate 
                          ? 'bg-blue-50 border-blue-100 text-blue-700' 
                          : 'bg-slate-50 border-slate-100/50 text-slate-700 hover:border-slate-200'
                      }`}
                    >
                      {editingEventId === event.id ? (
                        <input
                          autoFocus
                          className="flex-1 bg-transparent border-b border-slate-200 outline-none font-semibold text-slate-700"
                          defaultValue={event.text}
                          onBlur={(e) => handleUpdateEventText(event.id, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && handleUpdateEventText(event.id, e.currentTarget.value)}
                        />
                      ) : (
                        <>
                          <div className="flex justify-between items-start leading-tight">
                            <span 
                              className="font-semibold text-slate-700 line-clamp-1 cursor-pointer flex-1 py-0.5" 
                              onClick={() => setEditingEventId(event.id)}
                            >
                              {event.text}
                            </span>
                            <div className="flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity pt-0.5">
                              <button onClick={() => setEditingEventId(event.id)}>
                                <Edit2 size={10} className="text-slate-400 hover:text-slate-600" />
                              </button>
                              <button onClick={() => removeEvent(event.id, format(day, 'yyyy-MM-dd'))}>
                                <Trash2 size={10} className="text-slate-400 hover:text-red-400" />
                              </button>
                            </div>
                          </div>
                          {event.time && (
                            <span className="text-[8px] font-black text-slate-400 uppercase tracking-tighter leading-none pb-0.5">
                              {(() => {
                                try {
                                  return format(new Date(`2000-01-01T${event.time}`), 'h:mm a');
                                } catch {
                                  return event.time;
                                }
                              })()}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  {dayEvents.length === 0 && (
                    <div className="h-full flex items-center justify-center">
                       <span className="text-[9px] text-slate-200 uppercase font-bold tracking-tighter">Quiet Day</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* --- Main Grid (4-5-3) --- */}
      <main className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
        {/* Daily Checklist (4 cols) */}
        <section className="md:col-span-4 bento-card flex flex-col">
          <div className="p-5 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg uppercase tracking-tight">Daily Checklist</h3>
              <button 
                onClick={() => {
                  setActiveAddingSection('daily');
                  setNewTaskText('');
                }} 
                className={`p-1 rounded-md transition-colors ${activeAddingSection === 'daily' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 p-4 space-y-2">
            {activeAddingSection === 'daily' && (
              <div className="p-2 bg-white border border-slate-900 rounded-lg shadow-sm border-b-2 mb-2">
                <input
                  autoFocus
                  className="w-full text-[11px] font-bold outline-none"
                  placeholder="What needs doing today?"
                  value={newTaskText}
                  onChange={e => setNewTaskText(e.target.value)}
                  onBlur={submitNewTask}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitNewTask();
                    if (e.key === 'Escape') setActiveAddingSection(null);
                  }}
                />
              </div>
            )}
            <ModernTaskListView 
              tasks={state.tasks.filter(t => t.section === 'daily')} 
              onToggle={toggleTask} 
              onUpdateText={handleUpdateTaskText}
              onDelete={removeTaskClick}
              onReorder={(newOrder) => handleReorderTasks(newOrder, 'daily')}
              onSetPriority={setPriority}
              onSetDeadline={openDeadlineModal}
              onUpdateSubTasks={handleUpdateSubTasks}
              editingTaskId={editingTaskId}
              setEditingTaskId={setEditingTaskId}
              compact
              hidePriority
            />
          </div>
          <div className="p-3 bg-slate-50/50 rounded-b-[1.25rem] border-t border-slate-100">
          </div>
        </section>

        {/* Projects (5 cols) */}
        <section className="md:col-span-5 bento-card flex flex-col">
          <div className="p-5 border-b border-slate-100">
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-lg uppercase tracking-tight">Projects</h3>
              <button 
                onClick={() => {
                  setActiveAddingSection('projects');
                  setNewTaskText('');
                }} 
                className={`p-1 rounded-md transition-colors ${activeAddingSection === 'projects' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>
          <div className="flex-1 p-4 space-y-2">
            {activeAddingSection === 'projects' && (
              <div className="p-2 bg-white border border-slate-900 rounded-lg shadow-sm border-b-2">
                <input
                  autoFocus
                  className="w-full text-xs font-bold outline-none"
                  placeholder="New project task..."
                  value={newTaskText}
                  onChange={e => setNewTaskText(e.target.value)}
                  onBlur={submitNewTask}
                  onKeyDown={e => {
                    if (e.key === 'Enter') submitNewTask();
                    if (e.key === 'Escape') setActiveAddingSection(null);
                  }}
                />
              </div>
            )}
            <ModernTaskListView 
              tasks={state.tasks.filter(t => t.section === 'projects')} 
              onToggle={toggleTask} 
              onUpdateText={handleUpdateTaskText}
              onDelete={removeTaskClick}
              onReorder={(newOrder) => handleReorderTasks(newOrder, 'projects')}
              onSetPriority={setPriority}
              onSetDeadline={openDeadlineModal}
              onUpdateSubTasks={handleUpdateSubTasks}
              editingTaskId={editingTaskId}
              setEditingTaskId={setEditingTaskId}
              compact
            />
            {state.tasks.filter(t => t.section === 'projects').length === 0 && !activeAddingSection && (
              <div className="py-8 flex items-center justify-center text-slate-300 italic text-xs">No project tasks</div>
            )}
          </div>
          <div className="p-3 bg-slate-50/50 rounded-b-[1.25rem] border-t border-slate-100">
          </div>
        </section>

        {/* Other & Monthly (3 cols) */}
        <div className="md:col-span-3 flex flex-col gap-6">
          <section className="flex-1 bento-card flex flex-col">
            <div className="p-5 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg uppercase tracking-tight">Other</h3>
                <button 
                  onClick={() => {
                    setActiveAddingSection('other');
                    setNewTaskText('');
                  }} 
                  className={`p-1 rounded-md transition-colors ${activeAddingSection === 'other' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 p-4 space-y-2">
              {activeAddingSection === 'other' && (
                <div className="p-2 bg-white border border-slate-900 rounded-lg shadow-sm border-b-2 mb-2">
                  <input
                    autoFocus
                    className="w-full text-[11px] font-bold outline-none"
                    placeholder="Other task..."
                    value={newTaskText}
                    onChange={e => setNewTaskText(e.target.value)}
                    onBlur={submitNewTask}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitNewTask();
                      if (e.key === 'Escape') setActiveAddingSection(null);
                    }}
                  />
                </div>
              )}
              <ModernTaskListView 
                tasks={state.tasks.filter(t => t.section === 'other')} 
                onToggle={toggleTask} 
                onUpdateText={handleUpdateTaskText}
                onDelete={removeTaskClick}
                onReorder={(newOrder) => handleReorderTasks(newOrder, 'other')}
                onSetPriority={setPriority}
                onSetDeadline={openDeadlineModal}
                onUpdateSubTasks={handleUpdateSubTasks}
                editingTaskId={editingTaskId}
                setEditingTaskId={setEditingTaskId}
                compact
              />
              {state.tasks.filter(t => t.section === 'other').length === 0 && !activeAddingSection && (
                <div className="py-4 flex items-center justify-center text-slate-300 italic text-xs text-center">No other tasks</div>
              )}
            </div>
            <div className="p-3 bg-slate-50/50 rounded-b-[1.25rem] border-t border-slate-100">
            </div>
          </section>
 
          <section className="flex-1 bento-card flex flex-col relative">
            <div className="p-5 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-lg uppercase tracking-tight">Monthly</h3>
                <button 
                  onClick={() => {
                    setActiveAddingSection('monthly');
                    setNewTaskText('');
                  }} 
                  className={`p-1 rounded-md transition-colors ${activeAddingSection === 'monthly' ? 'bg-slate-900 text-white' : 'hover:bg-slate-100'}`}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>
            <div className="flex-1 p-4 space-y-2">
              {activeAddingSection === 'monthly' && (
                <div className="p-2 bg-white border border-slate-900 rounded-lg shadow-sm border-b-2 mb-2">
                  <input
                    autoFocus
                    className="w-full text-[11px] font-bold outline-none"
                    placeholder="Monthly item..."
                    value={newTaskText}
                    onChange={e => setNewTaskText(e.target.value)}
                    onBlur={submitNewTask}
                    onKeyDown={e => {
                      if (e.key === 'Enter') submitNewTask();
                      if (e.key === 'Escape') setActiveAddingSection(null);
                    }}
                  />
                </div>
              )}
              <ModernTaskListView 
                tasks={state.tasks.filter(t => t.section === 'monthly')} 
                onToggle={toggleTask} 
                onUpdateText={handleUpdateTaskText}
                onDelete={removeTaskClick}
                onReorder={(newOrder) => handleReorderTasks(newOrder, 'monthly')}
                onSetPriority={setPriority}
                onSetDeadline={openDeadlineModal}
                onUpdateSubTasks={handleUpdateSubTasks}
                editingTaskId={editingTaskId}
                setEditingTaskId={setEditingTaskId}
                compact
                hidePriority
              />
            </div>
            <div className="p-3 bg-slate-50/50 rounded-b-[1.25rem] border-t border-slate-100">
            </div>
          </section>
        </div>
      </main>

      {/* --- Footer Sections --- */}
      <footer className="space-y-4">
        {/* --- Completed Section --- */}
        <section className="bento-card p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setIsHistoryOpen(!isHistoryOpen)}>
              <span className={`text-slate-400 transition-transform ${isHistoryOpen ? 'rotate-0' : '-rotate-90'}`}>▼</span>
              <h3 className="font-bold text-lg uppercase tracking-tight group-hover:text-slate-600 transition-colors">Completed</h3>
            </div>
          </div>

          <AnimatePresence>
            {isHistoryOpen && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10 pb-2"
              >
                {Object.keys(historyGroupedByMonth).sort((a,b) => new Date(a).getTime() - new Date(b).getTime()).map(month => {
                  const monthHistory = historyGroupedByMonth[month];
                  const isCollapsed = collapsedMonths[month] !== undefined ? collapsedMonths[month] : monthHistory.length === 0;
                  return (
                    <div key={month} className="space-y-4">
                      <div 
                        className="flex items-center gap-2 cursor-pointer group/header w-fit"
                        onClick={() => setCollapsedMonths(prev => ({ ...prev, [month]: !prev[month] }))}
                      >
                        <h4 className="text-[12px] font-extrabold text-slate-400 uppercase tracking-widest border-b border-slate-900 pb-1">{month}</h4>
                        <span className={`text-[10px] text-slate-300 transition-transform ${isCollapsed ? '-rotate-90' : 'rotate-0'}`}>▼</span>
                      </div>
                      
                      <AnimatePresence>
                        {!isCollapsed && (
                          <motion.div 
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="text-[11px] font-medium text-slate-600 leading-normal space-y-2">
                              {[...monthHistory].sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()).map(item => (
                                <HistoryItemView 
                                  key={item.id} 
                                  item={item} 
                                  editingTaskId={editingTaskId}
                                  onEdit={setEditingTaskId}
                                  onUpdate={handleUpdateHistoryTask}
                                  onRestore={restoreTask}
                                  onToggleYearly={toggleYearlyReview}
                                  onUpdateDate={handleUpdateHistoryDate}
                                  onRemove={removeHistoryItem}
                                />
                              ))}
                              {monthHistory.length === 0 && (
                                <p className="text-[10px] italic text-slate-300">No items completed this month</p>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
                {state.history.length === 0 && <p className="text-xs italic text-slate-300">Your journey begins here...</p>}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* --- Yearly Review Section --- */}
        <section className="bento-card p-6 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setIsYearlyReviewOpen(!isYearlyReviewOpen)}>
              <span className={`text-slate-400 transition-transform ${isYearlyReviewOpen ? 'rotate-0' : '-rotate-90'}`}>▼</span>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-lg uppercase tracking-tight group-hover:text-slate-600 transition-colors">Yearly Review</h3>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button 
                onClick={() => {
                  const yearlyItems = state.history.filter(t => t.savedForYearlyReview);
                  const sortedItems = [...yearlyItems].sort((a,b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime());
                  const text = sortedItems.map(item => {
                    try {
                      return `[${format(new Date(item.completedAt), 'MMM d')}] ${item.text}`;
                    } catch {
                      return `[?] ${item.text}`;
                    }
                  }).join('\n');
                  copy(text);
                  alert('Copied to clipboard!');
                }}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 transition-colors"
                title="Copy highlights"
              >
                <Copy size={14} />
              </button>
              <button 
                onClick={() => setIsYearlyReviewModalOpen(true)}
                className="px-3 py-1 bg-slate-900 text-white text-[10px] font-bold uppercase rounded-md hover:bg-slate-800 transition-colors flex items-center gap-2"
              >
                <ExternalLink size={12} /> Finalize
              </button>
            </div>
          </div>

          <AnimatePresence>
            {isYearlyReviewOpen && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10 pb-2"
              >
                {Object.keys(historyGroupedByMonth)
                  .sort((a,b) => new Date(a).getTime() - new Date(b).getTime())
                  .filter(month => historyGroupedByMonth[month].some(t => t.savedForYearlyReview))
                  .map(month => {
                    const yearlyItems = historyGroupedByMonth[month].filter(item => item.savedForYearlyReview);
                    const isCollapsed = collapsedMonths[`yearly_${month}`];
                    
                    return (
                      <div key={month} className="space-y-4">
                        <div 
                          className="flex items-center gap-2 cursor-pointer group/header w-fit"
                          onClick={() => setCollapsedMonths(prev => ({ ...prev, [`yearly_${month}`]: !prev[`yearly_${month}`] }))}
                        >
                          <h4 className="text-[12px] font-extrabold text-amber-500 uppercase tracking-widest border-b border-amber-900 pb-1 w-fit">{month}</h4>
                          <span className={`text-[10px] text-amber-300 transition-transform ${isCollapsed ? '-rotate-90' : 'rotate-0'}`}>▼</span>
                        </div>

                        <AnimatePresence>
                          {!isCollapsed && (
                            <motion.div 
                              initial={{ height: 0, opacity: 0 }}
                              animate={{ height: 'auto', opacity: 1 }}
                              exit={{ height: 0, opacity: 0 }}
                              className="overflow-hidden"
                            >
                              <div className="text-[11px] font-medium text-slate-900 leading-normal space-y-2">
                                {[...yearlyItems].sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()).map(item => (
                                  <HistoryItemView 
                                    key={item.id} 
                                    item={item} 
                                    editingTaskId={editingTaskId}
                                    onEdit={setEditingTaskId}
                                    onUpdate={handleUpdateHistoryTask}
                                    onRestore={restoreTask}
                                    onToggleYearly={toggleYearlyReview}
                                    onUpdateDate={handleUpdateHistoryDate}
                                    onRemove={removeHistoryItem}
                                  />
                                ))}
                              </div>
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    );
                  })}
                {state.history.filter(t => t.savedForYearlyReview).length === 0 && (
                  <p className="text-xs italic text-slate-300">Star items above to mark them for your yearly review.</p>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </section>

        {/* --- Archive Sections --- */}
        {Object.entries(state.archives).map(([title, archiveDoc]: [string, { id: string, items: HistoryItem[] }]) => (
          <section key={title} className="bento-card p-6 flex flex-col border-slate-200">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3 cursor-pointer group" onClick={() => setOpenArchives(prev => ({ ...prev, [title]: !prev[title] }))}>
                <span className={`text-slate-400 transition-transform ${openArchives[title] ? 'rotate-0' : '-rotate-90'}`}>▼</span>
                <div className="flex items-center gap-2">
                  {editingArchiveTitle === title ? (
                    <input 
                      autoFocus
                      className="bg-transparent border-b border-slate-900 font-bold text-lg uppercase tracking-tight outline-none"
                      defaultValue={title}
                      onBlur={(e) => renameArchive(title, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') renameArchive(title, e.currentTarget.value);
                        if (e.key === 'Escape') setEditingArchiveTitle(null);
                      }}
                    />
                  ) : (
                    <h3 className="font-bold text-lg uppercase tracking-tight group-hover:text-slate-600 transition-colors">{title}</h3>
                  )}
                </div>
              </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={() => copyToClipboard(title, archiveDoc.items)}
                      className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-900 transition-colors"
                      title="Copy to Clipboard (with formatting)"
                    >
                      <Copy size={12} />
                    </button>
                    <button 
                      onClick={() => downloadAsHTML(title, archiveDoc.items)}
                      className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-900 transition-colors"
                      title="Download as HTML"
                    >
                      <Download size={12} />
                    </button>
                    <button 
                      onClick={() => restoreArchive(title)}
                      className="flex items-center gap-1 px-2 py-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-900 transition-colors"
                      title="Undo and restore everything back to History"
                    >
                      <RotateCcw size={12} />
                      <span className="text-[10px] font-black uppercase">Undo</span>
                    </button>
                <button 
                  onClick={() => setEditingArchiveTitle(title)}
                  className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 transition-colors"
                  title="Rename archive"
                >
                  <Edit2 size={12} />
                </button>
                <button 
                  onClick={() => deleteArchive(title)}
                  className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-red-500 transition-colors"
                  title="Delete archive"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>

            <AnimatePresence>
              {openArchives[title] && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="space-y-12 pb-2"
                >
                  {/* --- Yearly Review Section --- */}
                  <div className="space-y-6">
                    <div className="flex items-center gap-4">
                      <h4 className="text-[14px] font-black text-slate-900 uppercase tracking-[0.2em] bg-yellow-400 px-3 py-0.5">Yearly Review Highlights</h4>
                      <div className="h-px flex-1 bg-slate-100" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-8">
                      {Object.entries(
                        archiveDoc.items.filter(i => i.savedForYearlyReview).reduce((acc, item) => {
                          const month = format(new Date(item.completedAt), 'MMMM yyyy');
                          if (!acc[month]) acc[month] = [];
                          acc[month].push(item);
                          return acc;
                        }, {} as Record<string, HistoryItem[]>)
                      )
                      .sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                      .map(([month, monthItems]) => (
                        <div key={month} className="space-y-4 border-r border-slate-100 pr-10 last:border-none">
                          <h4 className="text-[11px] font-extrabold text-slate-400 uppercase tracking-widest border-b border-slate-900 pb-1 w-fit">{month}</h4>
                          <div className="text-[11px] font-medium text-slate-900 leading-normal space-y-2">
                            {monthItems.map(item => (
                              <div key={item.id} className="flex items-center justify-between group">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Star size={8} className="text-yellow-500 fill-yellow-500 flex-shrink-0" />
                                  <span className="uppercase tracking-tight truncate">{item.text}</span>
                                </div>
                                <button 
                                  onClick={() => deleteItemFromArchive(archiveDoc.id, item.id)}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-red-500"
                                >
                                  <Trash2 size={9} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {archiveDoc.items.filter(i => i.savedForYearlyReview).length === 0 && (
                      <p className="text-[10px] italic text-slate-300">No highlighted accomplishments in this period.</p>
                    )}
                  </div>

                  {/* --- Other Things Done Section --- */}
                  <div className="space-y-6">
                    <div className="flex items-center gap-4">
                      <h4 className="text-[12px] font-black text-slate-400 uppercase tracking-[0.2em]">Other Things Done</h4>
                      <div className="h-px flex-1 bg-slate-50" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-10 gap-y-8">
                      {Object.entries(
                        archiveDoc.items.filter(i => !i.savedForYearlyReview).reduce((acc, item) => {
                          const month = format(new Date(item.completedAt), 'MMMM yyyy');
                          if (!acc[month]) acc[month] = [];
                          acc[month].push(item);
                          return acc;
                        }, {} as Record<string, HistoryItem[]>)
                      )
                      .sort((a,b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                      .map(([month, monthItems]) => (
                        <div key={month} className="space-y-4 border-r border-slate-100 pr-10 last:border-none">
                          <h4 className="text-[11px] font-extrabold text-slate-200 uppercase tracking-widest border-b border-slate-100 pb-1 w-fit">{month}</h4>
                          <div className="text-[11px] font-medium text-slate-400 leading-normal space-y-2">
                            {monthItems.map(item => (
                              <div key={item.id} className="flex items-center justify-between group">
                                <span className="uppercase tracking-tight truncate">{item.text}</span>
                                <button 
                                  onClick={() => deleteItemFromArchive(archiveDoc.id, item.id)}
                                  className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-red-500"
                                >
                                  <Trash2 size={9} />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                    {archiveDoc.items.filter(i => !i.savedForYearlyReview).length === 0 && (
                      <p className="text-[10px] italic text-slate-100">No other items in this period.</p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        ))}
      </footer>

      {/* --- Delete Event Modal --- */}
      <AnimatePresence>
        {isDeleteModalOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl space-y-6 text-center"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-2">
                  <Trash2 size={24} />
                </div>
                <h3 className="text-xl font-bold">Delete Event?</h3>
                <p className="text-sm text-slate-500">This is a repeating event. How would you like to delete it?</p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => confirmDelete('one')}
                  className="w-full bg-slate-900 text-white py-3 rounded-xl font-bold text-sm hover:opacity-90 transition-opacity"
                >
                  Delete only this occurrence
                </button>
                <button 
                  onClick={() => confirmDelete('all')}
                  className="w-full bg-slate-100 text-slate-900 py-3 rounded-xl font-bold text-sm hover:bg-slate-200 transition-colors"
                >
                  Delete all future events
                </button>
                <button 
                  onClick={() => setIsDeleteModalOpen(false)}
                  className="w-full text-slate-400 py-2 text-xs font-bold uppercase tracking-widest hover:text-slate-600 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- Task Delete Confirmation Modal --- */}
      <AnimatePresence>
        {isTaskDeleteModalOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl space-y-6 text-center"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-2">
                  <Trash2 size={24} />
                </div>
                <h3 className="text-xl font-bold">Delete Task?</h3>
                <p className="text-sm text-slate-500">Are you sure you want to remove this task? This cannot be undone.</p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={confirmTaskDelete}
                  className="w-full bg-red-500 text-white py-3 rounded-xl font-bold text-sm hover:bg-red-600 transition-colors"
                >
                  Confirm Delete
                </button>
                <button 
                  onClick={() => setIsTaskDeleteModalOpen(false)}
                  className="w-full bg-slate-100 text-slate-900 py-3 rounded-xl font-bold text-sm hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}

        {isHistoryDeleteModalOpen && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl space-y-6 text-center"
            >
              <div className="flex flex-col items-center gap-2">
                <div className="w-12 h-12 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-2">
                  <Trash2 size={24} />
                </div>
                <h3 className="text-xl font-bold">Delete from History?</h3>
                <p className="text-sm text-slate-500">Permanently remove this item from your history record? This cannot be undone.</p>
              </div>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={confirmHistoryDelete}
                  className="w-full bg-red-500 text-white py-3 rounded-xl font-bold text-sm hover:bg-red-600 transition-colors"
                >
                  Permanently Delete
                </button>
                <button 
                  onClick={() => setIsHistoryDeleteModalOpen(false)}
                  className="w-full bg-slate-100 text-slate-900 py-3 rounded-xl font-bold text-sm hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isDeadlineModalOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 10, opacity: 0 }}
              className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-2xl space-y-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold">Set Deadline</h3>
                </div>
                <button onClick={() => setIsDeadlineModalOpen(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X size={16} /></button>
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Date</label>
                  <input 
                    type="date" 
                    className="w-full clean-input text-sm font-bold"
                    value={tempDeadlineDate}
                    onChange={(e) => setTempDeadlineDate(e.target.value)}
                  />
                </div>
                {taskForDeadline?.section !== 'projects' && taskForDeadline?.section !== 'other' && (
                  <div className="space-y-4 pt-2">
                    {taskForDeadline?.section === 'monthly' && (
                      <div className="space-y-2">
                        <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                          <input 
                            type="checkbox" 
                            checked={tempRepeatMonthly} 
                            onChange={e => setTempRepeatMonthly(e.target.checked)}
                            className="w-5 h-5 rounded accent-slate-900"
                          />
                          <div className="flex flex-col">
                            <span className="font-semibold text-slate-700 text-sm">Repeat Monthly</span>
                            <span className="text-[10px] text-slate-400 font-bold uppercase">Enable recurring task</span>
                          </div>
                        </label>

                        {tempRepeatMonthly && (
                          <div className="space-y-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                            <div className="flex gap-2 p-1 bg-slate-200/50 rounded-lg">
                              <button
                                onClick={() => setTempMonthlyRepeatType('day')}
                                className={`flex-1 px-3 py-1.5 text-xs font-bold rounded-md transition-all ${
                                  tempMonthlyRepeatType === 'day' 
                                    ? 'bg-white text-slate-900 shadow-sm' 
                                    : 'text-slate-500 hover:text-slate-700'
                                }`}
                              >
                                Specific Day
                              </button>
                              <button
                                onClick={() => setTempMonthlyRepeatType('nthWeekday')}
                                className={`flex-1 px-3 py-1.5 text-xs font-bold rounded-md transition-all ${
                                  tempMonthlyRepeatType === 'nthWeekday' 
                                    ? 'bg-white text-slate-900 shadow-sm' 
                                    : 'text-slate-500 hover:text-slate-700'
                                }`}
                              >
                                Flexible Day
                              </button>
                            </div>

                            {tempMonthlyRepeatType === 'day' ? (
                              <div className="flex flex-col gap-1">
                                <span className="text-[10px] text-slate-400 font-bold uppercase ml-1">On day of month</span>
                                <input 
                                  type="number" 
                                  min="1" 
                                  max="31"
                                  value={tempDeadlineDate ? new Date(tempDeadlineDate.replace(/-/g, '/')).getDate() : 1}
                                  onChange={(e) => {
                                    const d = tempDeadlineDate ? new Date(tempDeadlineDate.replace(/-/g, '/')) : new Date();
                                    d.setDate(parseInt(e.target.value) || 1);
                                    setTempDeadlineDate(format(d, 'yyyy-MM-dd'));
                                  }}
                                  className="clean-input text-sm font-bold w-full"
                                />
                                <span className="text-[10px] text-slate-400 font-medium ml-1">Every {tempDeadlineDate ? format(new Date(tempDeadlineDate.replace(/-/g, '/')), 'do') : 'month'}</span>
                              </div>
                            ) : (
                              <div className="space-y-3">
                                <div className="grid grid-cols-2 gap-2">
                                  <div className="flex flex-col gap-1">
                                    <span className="text-[10px] text-slate-400 font-bold uppercase ml-1">Occurrence</span>
                                    <select 
                                      className="clean-input text-sm font-bold appearance-none bg-white py-2"
                                      value={tempMonthlyRepeatNth}
                                      onChange={(e) => setTempMonthlyRepeatNth(e.target.value === 'last' ? 'last' : parseInt(e.target.value))}
                                    >
                                      {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : '4th'}</option>)}
                                      <option value="last">Last</option>
                                    </select>
                                  </div>
                                  <div className="flex flex-col gap-1">
                                    <span className="text-[10px] text-slate-400 font-bold uppercase ml-1">Weekday</span>
                                    <select 
                                      className="clean-input text-sm font-bold appearance-none bg-white py-2"
                                      value={tempMonthlyRepeatWeekday}
                                      onChange={(e) => setTempMonthlyRepeatWeekday(parseInt(e.target.value))}
                                    >
                                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                                        <option key={i} value={i}>{d}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                                <div className="text-center p-2 border-t border-slate-100">
                                  <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">
                                    Repeats every {tempMonthlyRepeatNth === 'last' ? 'Last' : tempMonthlyRepeatNth === 1 ? '1st' : tempMonthlyRepeatNth === 2 ? '2nd' : tempMonthlyRepeatNth === 3 ? '3rd' : '4th'} {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][tempMonthlyRepeatWeekday]}
                                  </span>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="space-y-1">
                      <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Time (Optional)</label>
                      <div className="relative group">
                        <input 
                          type="time" 
                          className="w-full clean-input text-sm font-bold cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                          value={tempDeadlineTime}
                          onChange={(e) => setTempDeadlineTime(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}
                <div className="flex gap-3">
                  <button 
                    onClick={handleClearDeadline}
                    className="flex-1 py-3 border border-slate-200 text-slate-400 rounded-xl text-xs font-bold uppercase tracking-widest hover:border-slate-300 hover:text-slate-600 transition-colors"
                  >
                    Clear
                  </button>
                  <button 
                    onClick={() => handleSetDeadline(tempDeadlineTime && taskForDeadline?.section !== 'projects' && taskForDeadline?.section !== 'other' ? `${tempDeadlineDate}T${tempDeadlineTime}` : tempDeadlineDate)}
                    className="flex-[2] py-3 bg-slate-900 text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-slate-800 transition-colors"
                  >
                    Save Deadline
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- Yearly Review Modal --- */}
      <AnimatePresence>
        {isYearlyReviewModalOpen && (
          <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-white rounded-3xl p-8 max-w-2xl w-full shadow-2xl flex flex-col max-h-[90vh]"
            >
              <div className="flex items-center justify-between mb-6 border-b border-slate-100 pb-4">
                <div className="flex items-center gap-3">
                  <div>
                    <h2 className="text-2xl font-black uppercase tracking-tight">Yearly Review</h2>
                    <p className="text-xs font-bold text-slate-400 uppercase">Archive of your accomplishments</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => {
                      const majorityYear = getYear(new Date()); // Best guess for current title
                      copyToClipboard(`Yearly Review ${majorityYear}`, state.history);
                    }}
                    className="p-2 hover:bg-slate-100 rounded-full shadow-sm transition-all text-slate-600"
                    title="Copy to Clipboard (with formatting)"
                  >
                    <Copy size={20} />
                  </button>
                  <button 
                    onClick={() => {
                      const majorityYear = getYear(new Date());
                      downloadAsHTML(`Yearly Review ${majorityYear}`, state.history);
                    }}
                    className="p-2 hover:bg-slate-100 rounded-full shadow-sm transition-all text-slate-600"
                    title="Download as HTML"
                  >
                    <Download size={20} />
                  </button>
                  <button onClick={() => setIsYearlyReviewModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full shadow-sm transition-all ml-2">
                    <X size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto space-y-12 pr-2 scrollbar-none">
                {/* --- Highlights --- */}
                <div className="space-y-6">
                  {state.history.filter(t => t.savedForYearlyReview).length === 0 ? (
                    <div className="h-40 flex flex-col items-center justify-center text-slate-300 gap-2 border-2 border-dashed border-slate-100 rounded-2xl">
                      <Star size={32} />
                      <p className="italic text-sm text-center px-10">No items marked for review yet.</p>
                    </div>
                  ) : (
                    Object.entries(
                      state.history
                        .filter(t => t.savedForYearlyReview)
                        .reduce((acc, item) => {
                          const month = format(new Date(item.completedAt), 'MMMM yyyy');
                          if (!acc[month]) acc[month] = [];
                          acc[month].push(item);
                          return acc;
                        }, {} as Record<string, HistoryItem[]>)
                    )
                    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                    .map(([month, items]: [string, HistoryItem[]]) => (
                      <div key={month} className="space-y-3">
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-400 border-b border-slate-900 pb-1 w-fit">{month}</h3>
                        <div className="space-y-2">
                          {items.map(item => (
                            <div key={item.id} className="flex items-center gap-3">
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <Star size={10} className="text-yellow-500 fill-yellow-500 flex-shrink-0" />
                                <span className="text-[13px] font-bold uppercase tracking-tight text-slate-900 truncate">{item.text}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* --- Other Things Done --- */}
                <div className="space-y-6">
                  <div className="flex items-center gap-4">
                    <h4 className="text-[12px] font-black text-slate-400 uppercase tracking-[0.2em]">Other Things Done</h4>
                    <div className="h-px flex-1 bg-slate-50" />
                  </div>
                  {state.history.filter(t => !t.savedForYearlyReview).length === 0 ? (
                    <p className="text-[10px] italic text-slate-100 text-center">No other items yet.</p>
                  ) : (
                    Object.entries(
                      state.history
                        .filter(t => !t.savedForYearlyReview)
                        .reduce((acc, item) => {
                          const month = format(new Date(item.completedAt), 'MMMM yyyy');
                          if (!acc[month]) acc[month] = [];
                          acc[month].push(item);
                          return acc;
                        }, {} as Record<string, HistoryItem[]>)
                    )
                    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
                    .map(([month, items]: [string, HistoryItem[]]) => (
                      <div key={month} className="space-y-3">
                        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-200 border-b border-slate-100 pb-1 w-fit">{month}</h3>
                        <div className="space-y-2">
                          {items.map(item => (
                            <div key={item.id} className="flex items-center justify-between group">
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <span className="text-[11px] font-medium uppercase tracking-tight text-slate-400 truncate">{item.text}</span>
                              </div>
                              <button 
                                onClick={() => removeHistoryItem(item.id)}
                                className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 hover:text-red-500 text-slate-200"
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="mt-8 pt-6 border-t border-slate-100 flex gap-4">
                <button 
                  onClick={() => setIsYearlyReviewModalOpen(false)}
                  className="flex-1 px-6 py-4 rounded-2xl font-black uppercase text-sm border-2 border-slate-100 hover:bg-slate-50 transition-all"
                >
                  Continue Planning
                </button>
                <button 
                  onClick={() => {
                    finalizeYearlyReview();
                    setIsYearlyReviewModalOpen(false);
                  }}
                  disabled={state.history.length === 0}
                  className="flex-1 px-6 py-4 bg-slate-900 text-white rounded-2xl font-black uppercase text-sm shadow-xl hover:shadow-2xl hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-50 disabled:hover:scale-100"
                >
                  Finalize for Yearly Review
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* --- Undo Toast --- */}
      <AnimatePresence>
        {showUndo && (
          <motion.div 
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-slate-900 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-4"
          >
            <p className="text-sm font-bold uppercase tracking-tight">Year archived</p>
            <button 
              onClick={handleUndoFinalize}
              className="bg-white text-slate-900 px-3 py-1 rounded-lg text-[10px] font-black uppercase hover:bg-slate-100 transition-colors"
            >
              Undo
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* --- Event Modal --- */}
      <AnimatePresence>
        {isEventModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 modal-backdrop">
            <motion.div 
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
              className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl space-y-6"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-2xl font-bold">New Plan</h3>
                <button onClick={() => setIsEventModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full"><X size={20} /></button>
              </div>
              <div className="space-y-4">
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Event Title</label>
                  <input 
                    autoFocus
                    className="w-full clean-input text-lg font-medium"
                    value={newEvent.text}
                    onChange={e => setNewEvent(prev => ({ ...prev, text: e.target.value }))}
                    placeholder="E.g., Team Sync"
                  />
                </div>
                {!newEvent.repeatWeekly && (
                  <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={newEvent.isMultiDay} 
                      onChange={e => {
                        const isChecked = e.target.checked;
                        setNewEvent(prev => ({ 
                          ...prev, 
                          isMultiDay: isChecked,
                          startDate: format(addDays(currentWeekStart, prev.dayIndex), 'yyyy-MM-dd'),
                          endDate: format(addDays(currentWeekStart, prev.dayIndex), 'yyyy-MM-dd')
                        }));
                      }}
                      className="w-5 h-5 rounded accent-slate-900"
                    />
                    <span className="font-semibold text-slate-700">Multi-day / Time Off</span>
                  </label>
                )}

                {newEvent.isMultiDay && !newEvent.repeatWeekly ? (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-400 uppercase">Start Date</label>
                      <input 
                        type="date"
                        className="w-full clean-input"
                        value={newEvent.startDate}
                        onChange={e => setNewEvent(prev => ({ ...prev, startDate: e.target.value }))}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-bold text-slate-400 uppercase">End Date</label>
                      <input 
                        type="date"
                        className="w-full clean-input"
                        value={newEvent.endDate}
                        onChange={e => setNewEvent(prev => ({ ...prev, endDate: e.target.value }))}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <label className="text-xs font-bold text-slate-400 uppercase">Day</label>
                    <select 
                      className="w-full clean-input text-lg"
                      value={newEvent.dayIndex}
                      onChange={e => setNewEvent(prev => ({ ...prev, dayIndex: parseInt(e.target.value) }))}
                    >
                      {[0,1,2,3,4,5,6].map(i => (
                        <option key={i} value={i}>{format(addDays(currentWeekStart, i), 'EEEE')}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-xs font-bold text-slate-400 uppercase">Time (Optional)</label>
                  <div className="relative group">
                    <input 
                      type="time" 
                      className="w-full clean-input text-lg cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                      value={newEvent.time}
                      onChange={e => setNewEvent(prev => ({ ...prev, time: e.target.value }))}
                    />
                  </div>
                </div>
                <label className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer">
                  <input 
                    type="checkbox" 
                    checked={newEvent.repeatWeekly} 
                    onChange={e => setNewEvent(prev => ({ ...prev, repeatWeekly: e.target.checked }))}
                    className="w-5 h-5 rounded accent-slate-900"
                  />
                  <span className="font-semibold text-slate-700">Repeat this every week</span>
                </label>
                <button 
                  onClick={addCalendarEvent}
                  disabled={!newEvent.text}
                  className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-lg hover:opacity-90 transition-opacity disabled:opacity-30"
                >
                  Confirm Event
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

const HistoryItemView: React.FC<{ 
  item: HistoryItem; 
  editingTaskId: string | null; 
  onEdit: (id: string | null) => void; 
  onUpdate: (id: string, text: string) => void; 
  onRestore: (id: string) => void;
  onToggleYearly: (id: string) => void;
  onUpdateDate: (id: string, date: string) => void;
  onRemove: (id: string) => void;
}> = ({ 
  item, 
  editingTaskId, 
  onEdit, 
  onUpdate, 
  onRestore,
  onToggleYearly,
  onUpdateDate,
  onRemove
}) => (
  <div 
    className={`group flex items-center justify-between gap-1.5 p-1 rounded hover:bg-slate-50 transition-all relative ${item.savedForYearlyReview ? 'border-l-2 border-amber-300 pl-2 bg-amber-50/20' : ''}`}
  >
    <div className="flex items-start gap-1.5 flex-1 min-w-0">
      <div className="w-1 h-1 bg-slate-200 rounded-full mt-1.5 flex-shrink-0 group-hover:bg-slate-400 transition-colors" />
      {editingTaskId === item.id ? (
        <div 
          className="flex flex-col gap-1 flex-1 history-edit-block"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              const textInput = e.currentTarget.querySelector('input') as HTMLInputElement;
              if (textInput) {
                onUpdate(item.id, textInput.value);
              }
            }
          }}
        >
          <input
            autoFocus
            className="flex-1 bg-white border border-slate-200 outline-none text-[11px] font-bold py-0.5 px-1 rounded"
            defaultValue={item.text}
            onKeyDown={(e) => e.key === 'Enter' && onUpdate(item.id, e.currentTarget.value)}
          />
          <input 
            type="date"
            className="text-[9px] bg-white border border-slate-200 rounded px-1 py-0.5 w-fit font-bold uppercase transition-all"
            defaultValue={(() => {
              try {
                return format(new Date(item.completedAt), 'yyyy-MM-dd');
              } catch {
                return '';
              }
            })()}
            onChange={(e) => onUpdateDate(item.id, e.target.value)}
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <span 
            className={`truncate cursor-pointer hover:text-slate-900 ${item.savedForYearlyReview ? 'font-bold' : ''}`}
            onClick={() => onEdit(item.id)}
          >
            {item.text} <span className="opacity-40 font-bold">({(() => {
              try {
                return format(new Date(item.completedAt), 'MMM d');
              } catch {
                return 'Date?';
              }
            })()})</span>
          </span>
        </div>
      )}
    </div>
    <div className="flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
      <button 
        onClick={() => onToggleYearly(item.id)}
        className={`p-1 rounded transition-colors ${item.savedForYearlyReview ? 'text-amber-500 hover:bg-amber-100' : 'text-slate-300 hover:text-slate-900 hover:bg-slate-100'}`}
        title={item.savedForYearlyReview ? "Remove from Yearly Review" : "Save for Yearly Review"}
      >
        <Star size={10} fill={item.savedForYearlyReview ? "currentColor" : "none"} />
      </button>
      <button 
        onClick={() => onRestore(item.id)}
        className="p-1 text-slate-300 hover:text-slate-900 hover:bg-white rounded transition-colors"
        title="Restore to original list"
      >
        <RotateCcw size={10} />
      </button>
      <button 
        onClick={() => onRemove(item.id)}
        className="p-1 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
        title="Delete permanently"
      >
        <Trash2 size={10} />
      </button>
    </div>
  </div>
);

function ModernTaskListView({ 
  tasks, 
  onToggle, 
  onUpdateText, 
  onDelete,
  onReorder,
  onSetPriority,
  onSetDeadline,
  onUpdateSubTasks,
  editingTaskId, 
  setEditingTaskId,
  compact = false,
  hidePriority = false
}: { 
  tasks: Task[], 
  onToggle: (id: string) => void,
  onUpdateText: (id: string, text: string) => void,
  onDelete: (id: string) => void,
  onReorder?: (newOrder: Task[]) => void,
  onSetPriority: (id: string, p: Priority) => void,
  onSetDeadline: (task: Task) => void,
  onUpdateSubTasks?: (id: string, subtasks: SubTask[]) => void,
  editingTaskId: string | null,
  setEditingTaskId: (id: string | null) => void,
  hidePriority?: boolean;
  compact?: boolean;
}) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(new Set());
  const [newSubTaskText, setNewSubTaskText] = useState<{ [taskId: string]: string }>({});

  const toggleExpand = (taskId: string) => {
    setExpandedTaskIds(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  };

  const handleAddSubTask = (taskId: string) => {
    const text = newSubTaskText[taskId];
    if (!text?.trim() || !onUpdateSubTasks) return;

    const task = tasks.find(t => t.id === taskId);
    if (!task) return;

    const subtasks = [...(task.subtasks || [])];
    subtasks.push({
      id: Math.random().toString(36).substr(2, 9),
      text: text.trim(),
      completed: false
    });

    onUpdateSubTasks(taskId, subtasks);
    setNewSubTaskText(prev => ({ ...prev, [taskId]: '' }));
  };

  const handleToggleSubTask = (taskId: string, subTaskId: string) => {
    if (!onUpdateSubTasks) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.subtasks) return;

    const subtasks = task.subtasks.map(st => 
      st.id === subTaskId ? { ...st, completed: !st.completed } : st
    );

    onUpdateSubTasks(taskId, subtasks);
  };

  const handleDeleteSubTask = (taskId: string, subTaskId: string) => {
    if (!onUpdateSubTasks) return;
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.subtasks) return;

    const subtasks = task.subtasks.filter(st => st.id !== subTaskId);
    onUpdateSubTasks(taskId, subtasks);
  };
  return (
    <Reorder.Group 
      axis="y" 
      values={tasks} 
      onReorder={onReorder || (() => {})} 
      className="space-y-1.5"
    >
      {tasks.length === 0 && <p className={`text-[11px] italic text-slate-300 text-center ${compact ? 'py-1' : 'py-4'}`}>No tasks pending.</p>}
      {tasks.map(task => (
        <Reorder.Item 
          key={task.id} 
          value={task}
          className={`flex flex-col rounded-lg transition-all group border border-slate-100 bg-white/50 hover:border-slate-200 cursor-grab active:cursor-grabbing ${compact ? 'p-1' : 'p-1.5 hover:bg-white'}`}
        >
          <div className="flex items-center space-x-1.5">
            <GripVertical size={10} className="text-slate-300 opacity-0 group-hover:opacity-100 flex-shrink-0" />
            <input 
              type="checkbox" 
              checked={task.completed} 
              onChange={() => onToggle(task.id)}
              className={`${compact ? 'w-3 h-3' : 'w-4 h-4'} rounded border-slate-300 cursor-pointer accent-slate-900 flex-shrink-0`} 
            />
            {editingTaskId === task.id ? (
              <input
                autoFocus
                className="flex-1 bg-transparent border-b border-slate-200 outline-none py-0 text-[11px] font-bold"
                defaultValue={task.text}
                onBlur={(e) => onUpdateText(task.id, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onUpdateText(task.id, e.currentTarget.value)}
              />
            ) : (
              <div className="flex-1 flex items-center justify-between min-w-0">
                <span 
                  className={`${compact ? 'text-[11px]' : 'text-xs'} transition-all cursor-pointer truncate ${task.completed ? 'opacity-30 line-through font-bold' : 'font-bold text-slate-800'}`}
                  onClick={() => setEditingTaskId(task.id)}
                >
                  {task.text}
                </span>
                <div className="flex items-center gap-1">
                  {!hidePriority && (
                    <div className="scale-[0.7] origin-right">
                      <PrioritySelect task={task} onSetPriority={onSetPriority} />
                    </div>
                  )}
                  <button 
                    onClick={() => onSetDeadline(task)}
                    className="p-0.5 hover:text-slate-900 opacity-0 group-hover:opacity-100 transition-opacity bg-slate-100 hover:bg-slate-200 rounded text-[8px] px-1 font-bold"
                    title="Set deadline"
                  >
                    {task.section === 'projects' || task.section === 'other' ? 'DUE' : 'TIME'}
                  </button>
                  <button 
                    onClick={() => onDelete(task.id)}
                    className="p-0.5 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 size={compact ? 10 : 12} />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); toggleExpand(task.id); }}
                    className={`p-0.5 hover:text-slate-900 transition-colors bg-slate-100 hover:bg-slate-200 rounded ${task.subtasks?.length ? 'text-slate-900' : 'text-slate-400'}`}
                    title={expandedTaskIds.has(task.id) ? "Collapse checklist" : "Expand checklist"}
                  >
                    {expandedTaskIds.has(task.id) ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                </div>
              </div>
            )}
          </div>
          <AnimatePresence>
            {expandedTaskIds.has(task.id) && (
              <motion.div 
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden bg-slate-50/50 rounded-md mt-1 ml-6 border-l-2 border-slate-200"
              >
                <div className="p-2 space-y-1.5">
                  {(task.subtasks || []).map(st => (
                    <div key={st.id} className="flex items-center gap-2 group/st">
                      <input 
                        type="checkbox" 
                        checked={st.completed}
                        onChange={() => handleToggleSubTask(task.id, st.id)}
                        className="w-3 h-3 rounded accent-slate-900 flex-shrink-0 cursor-pointer"
                      />
                      <span className={`text-[10px] flex-1 truncate ${st.completed ? 'opacity-30 line-through font-bold' : 'text-slate-600 font-bold'}`}>
                        {st.text}
                      </span>
                      <button 
                        onClick={() => handleDeleteSubTask(task.id, st.id)}
                        className="opacity-0 group-hover/st:opacity-100 p-0.5 hover:text-red-500 transition-opacity"
                      >
                        <Trash2 size={8} />
                      </button>
                    </div>
                  ))}
                  <div className="flex items-center gap-1.5 mt-1 border-t border-slate-100 pt-1.5">
                    <input 
                      className="flex-1 bg-white border border-slate-200 rounded px-1.5 py-0.5 text-[10px] outline-none font-bold placeholder:text-slate-300 shadow-sm"
                      placeholder="Add sub-task..."
                      value={newSubTaskText[task.id] || ''}
                      onChange={e => setNewSubTaskText(prev => ({ ...prev, [task.id]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.stopPropagation();
                          handleAddSubTask(task.id);
                        }
                      }}
                    />
                    <button 
                      onClick={() => handleAddSubTask(task.id)}
                      className="p-1 bg-slate-900 text-white rounded hover:bg-slate-800 transition-colors"
                    >
                      <Plus size={8} />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {task.deadline && (task.section !== 'daily' || task.deadline.includes('T')) && (
            <div 
              className={`flex items-center gap-1 ml-6 mt-0.5 cursor-pointer w-fit px-1.5 py-0.5 rounded border transition-colors ${(() => {
                try {
                  // The user requested that associations with "Time" (contains T) should not change colors
                  const dateStr = task.deadline.includes('T') ? task.deadline : task.deadline.replace(/-/g, '/');
                  const deadlineDate = new Date(dateStr);
                  const daysLeft = differenceInCalendarDays(deadlineDate, new Date());
                  const isLate = !task.completed && task.section !== 'daily' && task.section !== 'monthly' && (task.deadline.includes('T') ? deadlineDate < new Date() : daysLeft < 0);
                  
                  if (isLate && !task.repeatMonthly) return 'bg-red-50 text-red-600 border-red-200';
                  
                  // The user requested that associations with "Time" (contains T) should not change colors
                  if (task.deadline && task.deadline.includes('T')) return 'bg-slate-50 text-slate-400 border-slate-100';
                  
                  if (task.repeatMonthly) return 'bg-indigo-50 text-indigo-600 border-indigo-200';
                  
                  if (daysLeft <= 3) return 'bg-red-50 text-red-600 border-red-200';
                  if (daysLeft <= 7) return 'bg-amber-50 text-amber-600 border-amber-200';
                  if (daysLeft <= 14) return 'bg-blue-50 text-blue-600 border-blue-200';
                  return 'bg-slate-50 text-slate-400 border-slate-100';
                } catch {
                  return 'bg-slate-50 text-slate-400 border-slate-100';
                }
              })()}`}
              onClick={() => onSetDeadline(task)}
            >
               <span className="text-[7px] font-black uppercase tracking-tighter leading-none">
                 {(() => {
                   try {
                     const dateStr = task.deadline.includes('T') ? task.deadline : task.deadline.replace(/-/g, '/');
                     const date = new Date(dateStr);
                     const daysLeft = differenceInCalendarDays(date, new Date());
                     const isLate = !task.completed && task.section !== 'daily' && task.section !== 'monthly' && (task.deadline.includes('T') ? date < new Date() : daysLeft < 0);

                     if (isLate && !task.repeatMonthly) {
                       if (task.section === 'daily') return 'LATE | ' + format(date, 'h:mm a');
                       if (task.deadline.includes('T')) return 'LATE | ' + format(date, 'MMM d h:mm a');
                       return 'LATE | ' + format(date, 'MMM d, yyyy');
                     }

                     if (task.section === 'daily') {
                       return format(date, 'h:mm a');
                     }

                     if (task.repeatMonthly) {
                       const d = new Date(dateStr);
                       const timeStr = task.deadline.includes('T') ? ' | ' + format(d, 'h:mm a') : '';
                       
                       if (task.monthlyRepeatType === 'nthWeekday' && task.monthlyRepeatNth !== undefined && task.monthlyRepeatWeekday !== undefined) {
                         const n = task.monthlyRepeatNth;
                         const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][task.monthlyRepeatWeekday];
                         const ordinal = n === 'last' ? 'Last' : n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n === 4 ? '4th' : '5th';
                         return `EVERY ${ordinal} ${dayName}${timeStr}`;
                       }
                       
                       const dayNum = format(d, 'do');
                       return `EVERY ${dayNum}${timeStr}`;
                     }

                     if (task.deadline.includes('T')) {
                       if (daysLeft === 0) return 'TODAY | ' + format(date, 'h:mm a'); 
                       if (daysLeft === 1) return 'TOMORROW | ' + format(date, 'h:mm a'); 
                       return format(date, 'h:mm a');
                     }
                     if (daysLeft === 0) return 'TODAY'; 
                     if (daysLeft === 1) return 'TOMORROW'; 
                     return format(date, 'MMM d, yyyy');
                   } catch {
                     return task.deadline;
                   }
                 })()}
               </span>
            </div>
          )}
        </Reorder.Item>
      ))}
    </Reorder.Group>
  );
}
