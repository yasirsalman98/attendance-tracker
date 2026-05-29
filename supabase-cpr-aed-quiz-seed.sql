-- Restores the NSC First Aid, CPR & AED saved quiz library for excourse7233@gmail.com.
-- These quizzes are saved as drafts (is_active = false) so they appear in Load Saved Quiz Questions
-- without creating active student quiz sessions.

do $$
declare
  owner_id uuid;
  quiz_id uuid;
  question_id uuid;
  quiz_item jsonb;
  question_item record;
  choice_item record;
begin
  select id
  into owner_id
  from auth.users
  where lower(email) = 'excourse7233@gmail.com'
  limit 1;

  if owner_id is null then
    raise exception 'Cannot seed CPR AED quizzes because excourse7233@gmail.com was not found in auth.users.';
  end if;

  for quiz_item in
    select value
    from jsonb_array_elements($json$
[
  {
    "course_name": "NSC First Aid, CPR & AED",
    "quiz_title": "CPR AED Course Exam A",
    "quiz_description": "NSC First Aid, CPR & AED course exam A.",
    "questions": [
      {"text":"A victim with heat stroke usually has -","choices":[["hot, flushed skin.",true],["cool, pale skin.",false],["need for frequent urination.",false],["euphoria.",false]]},
      {"text":"When should you call 9-1-1?","choices":[["For any life-threatening condition",true],["Only if you cannot drive the victim to the emergency department",false],["Only if the victim refuses your help",false],["Only if you cannot reach a health care provider on the telephone",false]]},
      {"text":"During CPR, give chest compressions at a rate of at least -","choices":[["60-80 compressions per minute.",false],["80-100 compressions per minute.",false],["100-120 compressions per minute.",true],["120-140 compressions per minute.",false]]},
      {"text":"To protect yourself against all bloodborne diseases -","choices":[["wear a face mask whenever giving first aid.",false],["get vaccinated.",false],["wear gloves or use other barriers when blood or another body fluid is present.",true],["ask a victim about contagious diseases before giving first aid.",false]]},
      {"text":"After ensuring the scene is safe, the first thing you should do in the initial assessment of a victim is -","choices":[["count the victim's breathing rate.",false],["check for responsiveness.",true],["tilt the victim's head back.",false],["ask how the victim feels.",false]]},
      {"text":"When there are no signs of trauma, put a victim in the shock position on the -","choices":[["stomach, with feet raised 6-12 inches.",false],["stomach, with head turned to side.",false],["back, with head and shoulders raised 6-12 inches.",false],["back, with feet raised 6-12 inches.",true]]},
      {"text":"When a victim feels chest discomfort, pressure or pain that does not go away, call -","choices":[["9-1-1 if the pain does not go away within 10 minutes after taking aspirin.",false],["the victim's health care provider.",false],["9-1-1 immediately.",true],["9-1-1 only if the victim is also sweating heavily.",false]]},
      {"text":"The first thing to do for a responsive victim of a swallowed poison without an immediate threat to life is to -","choices":[["try to make the victim vomit.",false],["give the victim activated charcoal.",false],["drive the victim to the emergency department.",false],["call the Poison Control Center.",true]]},
      {"text":"The depth of chest compressions in CPR for an adult is -","choices":[["1 inch.",false],["1 1/2 inches.",false],["at least 2 inches but not more than 2.4 inches.",true],["as deep as you can press with your full weight.",false]]},
      {"text":"A victim having a severe allergic reaction to a bee sting may have -","choices":[["a sudden high fever.",false],["yellowish skin color.",false],["difficulty breathing.",true],["unbending fingers and toes.",false]]},
      {"text":"Move an unresponsive victim only -","choices":[["to drive the victim to the hospital.",false],["to get the victim inside.",false],["to straighten out a fractured limb.",false],["if the scene becomes unsafe.",true]]},
      {"text":"Put ice on a sprained ankle -","choices":[["for no more than 5 minutes, then off for at least 60 minutes.",false],["for 20 minutes (or 10 minutes if uncomfortable), then off for 30 minutes, then repeat.",true],["for at least 60 minutes, then off for 2 hours.",false],["as long as possible.",false]]},
      {"text":"An AED should be used on a non-breathing victim seen to collapse suddenly -","choices":[["only if CPR does not work.",false],["as soon as possible.",true],["only after the EMS dispatcher tells you to use it.",false],["after giving abdominal thrusts for choking.",false]]},
      {"text":"First aid for a serious burn includes -","choices":[["putting ice on the burn.",false],["putting a loose dressing on the burn after cooling it.",true],["pulling away burned clothing stuck to the skin.",false],["rubbing butter or oil into the burned skin.",false]]},
      {"text":"To control severe bleeding, first -","choices":[["elevate the bleeding part above the level of the heart.",false],["run cold water on the wound.",false],["put direct pressure on the wound.",true],["wrap a bandage as tight as you can over the wound.",false]]},
      {"text":"Put a non-trauma victim in the recovery position who is -","choices":[["responsive after being resuscitated.",false],["being given CPR.",false],["unresponsive and breathing.",true],["being analyzed by an AED.",false]]},
      {"text":"If a choking victim is coughing, you should -","choices":[["use the Heimlich maneuver.",false],["slap the victim hard on the back.",false],["give abdominal thrusts until the object is expelled.",false],["encourage continued coughing to expel the object.",true]]},
      {"text":"On which victim should you use spinal motion restriction while waiting for help to arrive?","choices":[["A man who fell from the roof of his house",false],["An elderly woman who fell on an icy sidewalk",false],["A child struck by an automobile while riding a bike",false],["All of the above",true]]},
      {"text":"What is the correct ratio of compressions to breaths in CPR?","choices":[["15 to 1",false],["15 to 2",false],["30 to 1",false],["30 to 2",true]]},
      {"text":"When connected properly to the victim, the AED unit will advise you when -","choices":[["you should administer a shock.",true],["the victim is breathing.",false],["the victim's airway is clear.",false],["the victim is about to vomit.",false]]}
    ]
  },
  {
    "course_name": "NSC First Aid, CPR & AED",
    "quiz_title": "CPR AED Course Exam B",
    "quiz_description": "NSC First Aid, CPR & AED course exam B.",
    "questions": [
      {"text":"A person suffering from heat exhaustion usually -","choices":[["has stopped sweating and has flushed skin.",false],["is sweating profusely and is thirsty.",true],["has convulsions.",false],["passes out.",false]]},
      {"text":"Which of the following is not one of the four goals when you help a victim?","choices":[["Keep the victim alive.",false],["Prevent the victim's condition from getting worse.",false],["Calm bystanders.",true],["Give first aid until help arrives.",false]]},
      {"text":"When giving CPR, chest compressions should be performed at a rate of at least -","choices":[["60-80 compressions per minute.",false],["80-100 compressions per minute.",false],["100-120 compressions per minute.",true],["120-140 compressions per minute.",false]]},
      {"text":"Which of the following are acceptable methods to protect yourself against bloodborne diseases?","choices":[["Wash your hands with soap and water.",false],["Do not touch your mouth, nose or eyes.",false],["Wear gloves or use other barriers when blood or another body fluid is present.",false],["All of the above",true]]},
      {"text":"When checking a victim you should first -","choices":[["move the victim to a comfortable location.",false],["check the victim all over and then call 9-1-1.",false],["tilt the victim's head back.",false],["check for life-threatening conditions.",true]]},
      {"text":"The proper position for a victim showing the signs of shock is -","choices":[["the recovery position.",false],["on the stomach, with head turned to side.",false],["on the back, with head and shoulders raised 6-12 inches if there are no signs of trauma.",false],["on the back, with feet raised 6-12 inches if there are no signs of trauma.",true]]},
      {"text":"When a victim feels chest discomfort, pressure or pain that does not go away -","choices":[["call 9 1 1 immediately.",false],["have the victim chew 1 adult aspirin or 2-4 low dose aspirin.",false],["have the victim rest comfortably while waiting for EMS to arrive.",false],["do all of these.",true]]},
      {"text":"When a person splashes a chemical substance into the eyes, you should -","choices":[["leave contact lenses in place for EMS.",false],["pat the eyes dry with paper towels.",false],["flush the eyes with a large amount of running water.",true],["drive the victim to an eye doctor.",false]]},
      {"text":"How far should you compress the chest in CPR for an adult?","choices":[["1 inch",false],["1 1/2 inches",false],["At least 2 inches but not more than 2.4 inches",true],["As deep as you can press with your full weight",false]]},
      {"text":"If the victim of a severe allergic reaction does not respond to the initial dose of an emergency epinephrine auto-injector -","choices":[["call the victim's physician for advice.",false],["administer a second dose if the arrival of advanced care is more than 5-10 minutes away.",true],["put the victim in the shock position.",false],["give CPR.",false]]},
      {"text":"If an unresponsive victim is in a position that may cause the airway to be blocked -","choices":[["move the victim only if needed to reach a safe location.",false],["place the victim in the recovery position.",true],["roll the victim onto his or her stomach.",false],["do not move the victim.",false]]},
      {"text":"When applying a splint to a possible fracture -","choices":[["make sure the splint supports the limb above and below the injury.",false],["place padding between a rigid splint and the injured limb.",false],["check the circulation after the splint is applied.",false],["do all of these.",true]]},
      {"text":"When you see a victim collapse suddenly and then is unresponsive and not breathing normally -","choices":[["perform 2 cycles of CPR and then send someone to get an AED.",false],["if an AED is immediately available, use it as soon as possible.",true],["apply the AED only after the EMS dispatcher tells you to use it.",false],["perform CPR until EMS arrives to use an AED.",false]]},
      {"text":"A second-degree burn -","choices":[["appears charred or leathery white.",false],["is red, dry and painful.",false],["is always life threatening.",false],["is swollen and red and may have streaks or blisters.",true]]},
      {"text":"Which of the following is advised to control severe bleeding on the scalp?","choices":[["Direct pressure on the wound",true],["Direct pressure on the wound with a warm pack",false],["Direct pressure on the wound with a cold pack",false],["Direct pressure on the wound followed by a tourniquet",false]]},
      {"text":"What is the correct positioning for an unresponsive victim who may have a neck, back, hip or pelvic injury?","choices":[["The position in which you found the victim",true],["The side-lying recovery position",false],["On the back with the head stabilized",false],["On the back with the feet elevated 6-12 inches",false]]},
      {"text":"If a responsive pregnant victim is choking, you should -","choices":[["use abdominal thrusts until the object is expelled.",false],["slap the victim hard on the back.",false],["give chest thrusts instead of abdominal thrusts.",true],["lie the victim down and perform CPR.",false]]},
      {"text":"In which of these victims would you be least likely to suspect a spinal injury?","choices":[["An unresponsive person older than 65 found with an unknown injury",false],["An adult who collapses in a restaurant",true],["A child struck by an automobile while riding a bike",false],["Someone who fell and has pain in the head, neck or back",false]]},
      {"text":"What is the correct ratio of compressions to breaths in CPR?","choices":[["15 to 1",false],["15 to 2",false],["30 to 1",false],["30 to 2",true]]},
      {"text":"When preparing to deliver a shock with an AED, you should -","choices":[["have your hands positioned to continue CPR immediately.",false],["ask the victim for permission to deliver the shock.",false],["open the victim's airway.",false],["make sure no one is touching the victim.",true]]}
    ]
  }
]
$json$::jsonb)
  loop
    delete from public.quiz_templates
    where owner_user_id = owner_id
      and course_name = quiz_item ->> 'course_name'
      and quiz_title = quiz_item ->> 'quiz_title';

    insert into public.quiz_templates (
      course_name,
      quiz_title,
      quiz_description,
      passing_score,
      quiz_duration_minutes,
      is_active,
      owner_user_id
    )
    values (
      quiz_item ->> 'course_name',
      quiz_item ->> 'quiz_title',
      quiz_item ->> 'quiz_description',
      80,
      30,
      false,
      owner_id
    )
    returning id into quiz_id;

    for question_item in
      select value, ordinality
      from jsonb_array_elements(quiz_item -> 'questions') with ordinality
    loop
      insert into public.quiz_questions (
        quiz_template_id,
        question_text,
        question_type,
        sort_order
      )
      values (
        quiz_id,
        question_item.value ->> 'text',
        'single_choice',
        question_item.ordinality - 1
      )
      returning id into question_id;

      for choice_item in
        select value, ordinality
        from jsonb_array_elements(question_item.value -> 'choices') with ordinality
      loop
        insert into public.quiz_answer_choices (
          question_id,
          choice_text,
          is_correct,
          sort_order
        )
        values (
          question_id,
          choice_item.value ->> 0,
          (choice_item.value ->> 1)::boolean,
          choice_item.ordinality - 1
        );
      end loop;
    end loop;
  end loop;

  perform pg_notify('pgrst', 'reload schema');
end;
$$;
